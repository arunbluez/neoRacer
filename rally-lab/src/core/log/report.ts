// report.md is written for a coding agent: one section per test with its
// parameters, summary numbers and a short table, then the robot profile and
// open warnings.

import type { RobotProfile } from '../model/profile';
import type { Settings } from '../settings';
import type { ResultTable, TestDefinition, TestRun } from '../tests/types';
import type { AutoSummary } from '../race/autoRun';
import type { TrackCalibration } from '../vision/calibration';
import type { SessionHeader } from './session';

/** One auto run as the report needs it: its auto.start and auto.end events. */
export type AutoRunReport = {
  t: number;
  start: { route?: string; style?: string; lengthCm?: number; settings?: Record<string, unknown>; start?: { from?: string; distCm?: number }; model?: Record<string, unknown> };
  end?: AutoSummary & { t: number };
  cam?: { frames: number; matPct: number; robotPct: number; fps: number };
};

export type ReportInput = {
  header: SessionHeader;
  runs: TestRun[];
  defs: TestDefinition[];
  profile?: RobotProfile;
  calibrations: TrackCalibration[];
  settings: Settings;
  eventCounts?: Record<string, number>;
  autoRuns?: AutoRunReport[];
};

const cell = (v: unknown): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '–';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
};

export function mdTable(t: ResultTable, maxRows = 40): string {
  const rows = t.rows.slice(0, maxRows);
  const lines = [
    t.title ? `**${t.title}**\n` : '',
    `| ${t.columns.map(cell).join(' | ')} |`,
    `| ${t.columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
  if (t.rows.length > maxRows) lines.push(`\n_${t.rows.length - maxRows} more rows in session.json_`);
  return lines.filter((l) => l !== '').join('\n');
}

const SURVEY_LABELS = [
  'lane blue end', 'lane purple', 'lane pink end', 'white border', 'black background', 'checkered white',
  'checkered black', 'start line', 'bridge deck',
];

/** Open questions the data in this session does not answer yet. */
export function openWarnings(input: Pick<ReportInput, 'runs' | 'profile' | 'calibrations' | 'settings'>): string[] {
  const { runs, profile: p, calibrations, settings } = input;
  const done = (id: string) => runs.some((r) => r.testId === id && r.status === 'done');
  const w: string[] = [];
  if (p?.packingSafe === undefined && !done('T1.4')) w.push('Packing not verified (T1.4): keep packWrites off.');
  else if (p?.packingSafe === false) w.push('Packing unsafe (T1.4): never join commands in one write.');
  if (settings.packWrites && p?.packingSafe !== true) w.push('packWrites is ON although packing is not proven safe.');
  if (!p?.blocking && !done('T1.5')) w.push('Blocking table not measured (T1.5): using firmware estimates.');
  if (p?.safePollHz === undefined && !done('T1.2')) w.push('Safe poll rate not measured (T1.2).');
  if (p?.safeWriteGapMs === undefined && !done('T1.3')) w.push(`Safe write gap not measured (T1.3): using ${settings.minWriteGapMs} ms.`);
  const surveyed = new Set<string>([
    ...Object.keys(p?.surfaces ?? {}),
    ...runs.filter((r) => r.testId === 'T2.1').map((r) => String((r.data as { surface?: string } | null)?.surface ?? '')),
  ]);
  const missing = SURVEY_LABELS.filter((l) => !surveyed.has(l));
  if (missing.length) w.push(`Surfaces not surveyed (T2.1): ${missing.join(', ')}.`);
  const lane = ['lane blue end', 'lane purple', 'lane pink end'].map((l) => p?.surfaces?.[l]?.code).filter((c) => c !== undefined);
  if (lane.length && new Set(lane).size > 1) w.push(`The lane does not read the same along its length: codes ${lane.join(', ')}.`);
  if (!p?.deadband) w.push('Deadband not measured (T3.1).');
  if (!p?.speedTable?.length) w.push('Speed table not measured (T3.2).');
  if (!p?.spinTable?.length) w.push('Spin table not measured (T3.4).');
  if (p?.trackWidthCm === undefined) w.push('Effective track width not measured (T3.5).');
  if (p && !p.compassCalibrated) w.push('Compass not calibrated: ?COMPASS would block the robot.');
  if (calibrations.length === 0) w.push('No camera calibration.');
  else if (calibrations.every((c) => c.reprojErrorCm.max > 2)) w.push('Camera calibration error above 2 cm.');
  if (p?.ledLatencyMs === undefined && !done('T4.5')) w.push('Camera LED latency not measured (T4.5).');
  return w;
}

function autoSection(runs: AutoRunReport[]): string[] {
  const out: string[] = ['', '## Auto runs (camera assisted)', ''];
  out.push('Errors are the follower\'s sideways distance from the planned path (cm), by its camera-corrected estimate. Per-tick data: auto.tick; camera fixes: auto.fix (dx, dy = camera − estimate); spins: auto.spin.');
  runs.forEach((r, i) => {
    const e = r.end;
    const st = r.start.settings ?? {};
    out.push('');
    out.push(`### Auto run ${i + 1} — ${e ? e.reason : 'no end recorded'}`);
    out.push('');
    out.push(`- At t = ${Math.round(r.t)} ms; route ${r.start.route ?? '?'}, ${r.start.style ?? '?'} turns, ${cell(st.speedCmS)} cm/s, camera ${st.cameraAssist ? 'on' : 'off'}, line guard ${st.lineGuard ? 'on' : 'off'}`);
    if (r.start.start) out.push(`- Start pose from ${r.start.start.from}${r.start.start.from === 'camera' ? `, ${cell(r.start.start.distCm)} cm from the start line` : ''}`);
    if (r.start.model) out.push(`- Motor model: \`${JSON.stringify(r.start.model)}\``);
    if (e) {
      out.push(`- ${e.finished ? 'Finished' : 'Stopped'} after ${(e.timeMs / 1000).toFixed(1)} s at ${e.progressCm} of ${e.lengthCm} cm`);
      out.push(`- Camera fixes: ${e.fixes.used} used of ${e.fixes.total} (${e.fixes.rejected} rejected, ${e.fixes.resets} resets); line-sensor events: ${e.lineEvents}`);
      out.push(`- Learned: turning bias ${e.learned.biasDegS} °/s, speed scale ${e.learned.speedScale}, turn scale ${e.learned.turnScale}`);
      if (r.cam) out.push(`- Camera: ${r.cam.frames} frames, ${r.cam.fps} fps, mat found ${r.cam.matPct} %, robot found ${r.cam.robotPct} %`);
      out.push('');
      out.push(mdTable({
        title: 'Per section', columns: ['section', 'time s', 'max err cm', 'mean err cm', 'camera fixes'],
        rows: e.sections.map((x) => [x.id, (x.timeMs / 1000).toFixed(1), x.maxErrCm, x.meanErrCm, x.fixes]),
      }));
      if (e.spins.length) {
        out.push('');
        out.push(mdTable({
          title: 'Spins (heading error 12 cm after, + = right)', columns: ['section', 'turn °', 'ms', 'heading err after °'],
          rows: e.spins.map((x) => [x.section, x.deltaDeg, x.durMs, x.headingErrAfterDeg ?? null]),
        }, 60));
      }
    }
  });
  return out;
}

export function buildReport(input: ReportInput): string {
  const { header, runs, defs, profile, calibrations } = input;
  const out: string[] = [];
  out.push(`# Rally Lab report — ${header.id}`);
  out.push('');
  out.push(`- Started: ${header.startedAt}`);
  out.push(`- Robot: ${header.robot ? `${header.robot.name} (id \`${header.robot.id}\`)` : 'none connected'}`);
  if (header.robots.length > 1) out.push(`- All robots this session: ${header.robots.map((r) => r.id).join(', ')}`);
  out.push(`- Transport: ${header.transport}${header.transport === 'mock' ? ' (SIMULATED robot — not real measurements)' : ''}`);
  out.push(`- Build: ${header.buildId} (${header.buildTime})`);
  out.push(`- Settings: minWriteGapMs ${input.settings.minWriteGapMs}, replyTimeoutMs ${input.settings.replyTimeoutMs}, packWrites ${input.settings.packWrites}`);
  if (input.eventCounts) {
    out.push(`- Events: ${Object.entries(input.eventCounts).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  out.push('');
  out.push('Times are ms unless stated; distances cm; mat origin top-left, x right, y down; headings in degrees, atan2(dy, dx) on the mat (0 = +x, 90 = +y).');
  out.push('Camera poses are the position of marker A (the headlights, ~5 cm ahead of the wheel axle). Full data: session.json and events.jsonl.');

  const order = new Map(defs.map((d, i) => [d.id, i]));
  const ids = [...new Set(runs.map((r) => r.testId))].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  for (const id of ids) {
    const def = defs.find((d) => d.id === id);
    const these = runs.filter((r) => r.testId === id).sort((a, b) => a.tStart - b.tStart);
    out.push('');
    out.push(`## ${id} ${def?.title ?? these[0].title}`);
    for (const r of these) {
      out.push('');
      out.push(`### Run ${r.runId} — ${r.status}${r.error ? ` (${r.error})` : ''}`);
      out.push('');
      out.push(`- At: ${r.startedAt}, ${Math.round(((r.tEnd ?? r.tStart) - r.tStart) / 100) / 10} s`);
      out.push(`- Params: \`${JSON.stringify(r.params)}\``);
      if (r.measuredBy) out.push(`- Measured by: ${r.measuredBy}`);
      if (r.summary) {
        const vals = Object.entries(r.summary.values).map(([k, v]) => `${k} = ${cell(v)}`);
        if (vals.length) out.push(`- Summary: ${vals.join(', ')}`);
        for (const n of r.summary.notes) out.push(`- ${n}`);
        for (const t of r.summary.tables) {
          out.push('');
          out.push(mdTable(t));
        }
      }
    }
    const agg = def?.aggregate?.(these);
    if (agg && these.length > 1) {
      out.push('');
      out.push(mdTable(agg));
    }
  }

  if (input.autoRuns?.length) out.push(...autoSection(input.autoRuns));

  out.push('');
  out.push('## Robot profile');
  out.push('');
  if (profile) {
    out.push('```json');
    out.push(JSON.stringify(profile, null, 2));
    out.push('```');
  } else out.push('No robot connected in this session.');

  if (calibrations.length) {
    out.push('');
    out.push('## Camera calibrations');
    for (const c of calibrations) {
      out.push('');
      out.push(`- \`${c.id}\` (${c.createdAt}): ${c.imageWidth}×${c.imageHeight} px, mat ${c.matWidthCm}×${c.matHeightCm} cm, reprojection rms ${c.reprojErrorCm.rms.toFixed(2)} cm / max ${c.reprojErrorCm.max.toFixed(2)} cm, ${c.extraPoints.length} extra points, ${c.landmarks.length} landmarks${c.classPercentages ? `, classes ${JSON.stringify(c.classPercentages)}` : ''}`);
      out.push(`  - H (image px → mat cm): \`${JSON.stringify(c.H.map((x) => Number(x.toPrecision(6))))}\``);
      for (const l of c.landmarks) out.push(`  - landmark ${l.name}: (${l.xCm.toFixed(1)}, ${l.yCm.toFixed(1)}) cm`);
    }
  }

  const warnings = openWarnings(input);
  out.push('');
  out.push('## Open warnings');
  out.push('');
  if (warnings.length) for (const w of warnings) out.push(`- ${w}`);
  else out.push('- None.');
  out.push('');
  return out.join('\n');
}
