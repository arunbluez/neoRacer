// Race engineer: reads Rally Lab session exports (the session zip from Auto →
// "Send runs to the engineer", or Data → Export), analyses the auto runs, and
// asks Claude for the next lap's tuning. Writes engineer-plan-<run>.json next
// to the input; load it in the app (Auto → Lap tuning → Load plan).
//
//   npm run engineer -- ~/Downloads/20261008-101500-puguz.zip
//   npm run engineer -- ~/Downloads                 (the newest zip there)
//   npm run engineer -- --watch ~/Downloads         (answer every new zip)
//
// Claude runs through the Claude Agent SDK on your Claude Code login: install
// Claude Code and sign in once (`claude`, then /login) on this computer.

import { existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { LogEvent } from '../src/core/log/events';
import { engineerBriefText, engineerContext, finishPlan, quickPlan, type EngineerContext } from '../src/core/race/engineerBrief';
import { planFileName, type EngineerPlan } from '../src/core/race/engineerPlan';
import { analyzeRuns, type RunAnalysis } from '../src/core/race/lapAnalysis';
import { tuningDiff } from '../src/core/race/tuning';
import { askEngineer } from './claude';

type Args = {
  inputs: string[];
  runs: number;
  model: string;
  effort: 'low' | 'medium' | 'high';
  offline: boolean;
  dryRun: boolean;
  watch?: string;
  out?: string;
};

const HELP = `Rally Lab race engineer

  npm run engineer -- <session.zip | events.jsonl | folder> [more…] [options]

Options
  --runs N        read the latest N auto runs (default 4)
  --model ID      Claude model (default claude-haiku-5-5; e.g. claude-sonnet-5-5 for a deeper look)
  --effort LEVEL  low | medium | high (default medium)
  --offline       no Claude: the app's quick tune as a plan
  --dry-run       print what Claude would be told, and stop
  --watch DIR     wait in DIR for new session zips and answer each one
  --out DIR       write the plan here (default: next to the input)
`;

function parseArgs(argv: string[]): Args {
  const a: Args = { inputs: [], runs: 4, model: 'claude-haiku-5-5', effort: 'medium', offline: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === '--help' || x === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (x === '--runs') a.runs = Math.max(1, Number(val()) || 4);
    else if (x === '--model') a.model = val();
    else if (x === '--effort') {
      const e = val();
      if (e !== 'low' && e !== 'medium' && e !== 'high') throw new Error('--effort is low, medium or high');
      a.effort = e;
    } else if (x === '--offline') a.offline = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--watch') a.watch = val();
    else if (x === '--out') a.out = val();
    else if (x.startsWith('--')) throw new Error(`unknown option ${x}`);
    else a.inputs.push(x);
  }
  return a;
}

type Session = { id: string; events: LogEvent[]; from: string };

function parseJsonl(text: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // a torn last line: skip it
    }
  }
  return out;
}

/** Sessions in a file: a session zip, an all-sessions zip, or an events.jsonl. */
function loadFile(path: string): Session[] {
  if (extname(path).toLowerCase() === '.jsonl') {
    return [{ id: basename(dirname(resolve(path))), events: parseJsonl(readFileSync(path, 'utf8')), from: path }];
  }
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const out: Session[] = [];
  for (const name of Object.keys(files)) {
    if (!/(^|\/)events\.jsonl$/.test(name)) continue;
    const prefix = name.slice(0, name.length - 'events.jsonl'.length);
    let id = prefix.replace(/\/$/, '') || basename(path, '.zip');
    const sj = files[`${prefix}session.json`];
    if (sj) {
      try {
        id = (JSON.parse(strFromU8(sj)) as { header?: { id?: string } }).header?.id ?? id;
      } catch {
        // keep the name
      }
    }
    out.push({ id, events: parseJsonl(strFromU8(files[name])), from: path });
  }
  if (!out.length) throw new Error(`${path}: no events.jsonl inside (is it a Rally Lab session zip?)`);
  return out;
}

/** The newest session zip in a folder. */
function newestZip(dir: string): string | undefined {
  const zips = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.zip'))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return zips[0]?.f;
}

function load(inputs: string[]): Session[] {
  const sessions: Session[] = [];
  for (const inp of inputs) {
    if (!existsSync(inp)) throw new Error(`${inp}: not found`);
    if (statSync(inp).isDirectory()) {
      const z = newestZip(inp);
      if (!z) throw new Error(`${inp}: no .zip in this folder`);
      sessions.push(...loadFile(z));
    } else sessions.push(...loadFile(inp));
  }
  // Session ids start with the date and time: oldest first.
  return sessions.sort((a, b) => a.id.localeCompare(b.id));
}

const s1 = (ms: number) => (ms / 1000).toFixed(1);

function printRuns(runs: RunAnalysis[]): void {
  console.log('\nRuns read (oldest first)');
  for (const r of runs) {
    const res = r.finished ? `lap ${s1(r.timeMs)} s` : `stopped in ${r.stop?.section ?? '?'} after ${s1(r.timeMs)} s: ${r.reason}`;
    console.log(`  ${r.id}  ${r.tuning.label.padEnd(16)} ${res}${r.predictedS ? `  (predicted ${r.predictedS} s)` : ''}`);
    const cells = r.sections.filter((x) => x.reached).map((x) => {
      const off = Math.max(x.straight?.maxOffCm ?? 0, x.turn?.maxOffCm ?? 0);
      const lines = (x.straight?.lineOne ?? 0) + (x.turn?.lineOne ?? 0) + (x.straight?.lineBoth ?? 0) + (x.turn?.lineBoth ?? 0);
      return `${x.id} ${s1(x.timeMs)}s ${off}cm${lines ? ` ${lines}L` : ''}${x.stoppedHere ? ' STOP' : ''}`;
    });
    console.log(`      ${cells.join(' · ')}`);
  }
}

function printPlan(plan: EngineerPlan, ctx: EngineerContext, warnings: string[]): void {
  console.log(`\n${plan.tuning.label}: ${plan.summary}`);
  console.log(`Predicted lap ${plan.predictedS} s (now ${ctx.profile.predictedS} s) · confidence ${plan.confidence}`);
  const diff = tuningDiff(ctx.current, plan.tuning);
  if (diff.length) {
    console.log('Changes');
    for (const d of diff) console.log(`  ${d.key.padEnd(24)} ${d.from ?? '–'} → ${d.to ?? '–'}`);
  } else console.log('No changes to the tuning.');
  for (const c of plan.changes) console.log(`  · ${c.what.replace(/[.:]+$/, '')} — ${c.why}`);
  if (plan.routeEdits.length) {
    console.log('Track code edits (applied only if you tick them in the app)');
    for (const e of plan.routeEdits) console.log(`  ${e.section} part ${e.part}: ${e.lengthCm !== undefined ? `length ${e.lengthCm}` : `radius ${e.radiusCm}`} cm — ${e.why ?? ''}`);
  }
  if (plan.watch.length) console.log(`Watch: ${plan.watch.join(' · ')}`);
  for (const w of warnings) console.log(`  ! ${w}`);
}

async function answer(args: Args, inputs: string[]): Promise<void> {
  const sessions = load(inputs);
  const all = sessions.flatMap((s) => analyzeRuns(s.events, s.id)).filter((r) => r.progressCm > 0);
  if (!all.length) throw new Error('No auto runs in these logs (Auto → Start lap writes them).');
  const runs = all.slice(-args.runs);
  const ctx = engineerContext(runs);
  printRuns(runs);
  if (args.dryRun) {
    console.log(`\n--- brief (${ctx.label}) ---\n${engineerBriefText(ctx)}`);
    return;
  }
  const createdAt = new Date().toISOString();
  let plan: EngineerPlan, warnings: string[] = [];
  if (args.offline) {
    plan = quickPlan(ctx, createdAt);
  } else {
    console.log(`\nAsking the engineer (${args.model}, effort ${args.effort})…`);
    const events = new Map(sessions.map((s) => [s.id, s.events]));
    const res = await askEngineer(ctx, { model: args.model, effort: args.effort, events, log: (l) => console.log(l) });
    console.log(`Answered in ${s1(res.ms)} s, ${res.turns} turns, ${res.toolCalls} tool calls.`);
    ({ plan, warnings } = finishPlan(res.answer, ctx, { engine: 'claude', model: res.model, createdAt }));
  }
  printPlan(plan, ctx, warnings);
  const dir = args.out ?? dirname(resolve(sessions[sessions.length - 1].from));
  const file = join(dir, planFileName(plan));
  writeFileSync(file, JSON.stringify(plan, null, 2));
  console.log(`\nPlan written: ${file}\nSend it to the phone and load it: Auto → Lap tuning → Load plan (or paste its text).`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.watch) {
    const dir = args.watch;
    console.log(`Watching ${dir} for session zips (Ctrl+C to stop)…`);
    const seen = new Map<string, number>();
    for (const f of readdirSync(dir)) if (f.endsWith('.zip')) seen.set(f, statSync(join(dir, f)).mtimeMs);
    let busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.toLowerCase().endsWith('.zip')) continue;
          const p = join(dir, f);
          const t = statSync(p).mtimeMs;
          if (seen.get(f) === t || Date.now() - t < 1500) continue; // new, and done being written
          seen.set(f, t);
          console.log(`\n=== ${f} ===`);
          try {
            await answer(args, [p, ...args.inputs]);
          } catch (err) {
            console.error(`  ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        busy = false;
      }
    };
    watch(dir, () => setTimeout(() => void check(), 2000));
    setInterval(() => void check(), 5000);
    return;
  }
  if (!args.inputs.length) {
    console.log(HELP);
    process.exit(1);
  }
  await answer(args, args.inputs);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
