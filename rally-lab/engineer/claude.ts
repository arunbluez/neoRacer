// One round with the race engineer: Claude through the Claude Agent SDK, which
// runs Claude Code underneath and so uses your Claude Code login (your
// subscription) unless ANTHROPIC_API_KEY is set. No built-in tools (it can't
// touch files or run commands); two tools of its own over the lap data:
// predict_lap (what a candidate tuning would do) and section_trace (one
// section of one run in detail). The answer is structured: the plan schema.

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { LogEvent } from '../src/core/log/events';
import { engineerPrompt, engineerSystem, planSchema, predictLap, type EngineerContext } from '../src/core/race/engineerBrief';
import { sectionTrace } from '../src/core/race/lapAnalysis';
import type { Tuning } from '../src/core/race/tuning';

export type AskOpts = {
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** The session logs, by session id (for section_trace). */
  events: Map<string, LogEvent[]>;
  log: (line: string) => void;
};

export type AskResult = { answer: unknown; model: string; auth: string; turns: number; ms: number; toolCalls: number };

const tuningShape = z.object({
  sections: z.record(z.string(), z.object({ straightCmS: z.number(), turnCmS: z.number() })),
  accelCmS2: z.number(),
  decelCmS2: z.number(),
  latAccelCmS2: z.number(),
  settleCm: z.number().optional(),
});

const text = (x: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(x) }] });

export async function askEngineer(ctx: EngineerContext, o: AskOpts): Promise<AskResult> {
  let toolCalls = 0;
  const server = createSdkMcpServer({
    name: 'rally',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'predict_lap',
        'Lap time the speed profile predicts for a candidate tuning (every section, acceleration, braking, grip, steering), per section, and the tuning the app would really apply after its limits (warnings say what was clipped).',
        { tuning: tuningShape },
        async ({ tuning }) => {
          toolCalls++;
          const t: Tuning = { ...ctx.current, ...tuning, sections: { ...ctx.current.sections, ...tuning.sections }, label: ctx.label, source: 'engineer' };
          const p = predictLap(ctx, t);
          o.log(`  predict_lap → ${p.predictedS} s${p.warnings.length ? ` (${p.warnings.length} clipped)` : ''}`);
          return text(p);
        },
      ),
      tool(
        'section_trace',
        'One section of one run in detail, every ~4 cm: distance along the lap, straight/turn, distance off the path (cm, + = right), heading error (deg), target speed (cm/s), camera age (ms); plus the line sensor events and the camera corrections in it.',
        { run: z.string().describe('Run id, e.g. "20261008-101500-puguz#3"'), section: z.string().describe('Section id, a–g') },
        async ({ run, section }) => {
          toolCalls++;
          const r = ctx.runs.find((x) => x.id === run);
          const ev = r ? o.events.get(r.sessionId) : undefined;
          const tr = r && ev ? sectionTrace(ev, r.n, section) : null;
          o.log(`  section_trace ${run} ${section}${tr ? '' : ' (not found)'}`);
          return tr ? text(tr) : { content: [{ type: 'text' as const, text: `No run ${run} or section ${section}.` }], isError: true };
        },
      ),
    ],
  });

  const t0 = Date.now();
  let auth = '?', model = o.model;
  const q = query({
    prompt: engineerPrompt(ctx),
    options: {
      systemPrompt: engineerSystem(ctx),
      model: o.model,
      effort: o.effort,
      // Nothing but its own two tools: no files, no shell, no web.
      tools: [],
      mcpServers: { rally: server },
      allowedTools: ['mcp__rally__predict_lap', 'mcp__rally__section_trace'],
      permissionMode: 'dontAsk',
      // Don't pick up CLAUDE.md, hooks or settings from wherever this runs.
      settingSources: [],
      persistSession: false,
      maxTurns: 16,
      outputFormat: { type: 'json_schema', schema: planSchema(ctx.route.sections.map((s) => s.id)) },
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      auth = m.apiKeySource === 'none' ? 'your Claude login (subscription)' : m.apiKeySource === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_API_KEY (API billing)' : m.apiKeySource;
      model = m.model;
      o.log(`Claude: ${model}, signed in with ${auth}`);
    } else if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) o.log(`  ${b.text.trim().split('\n')[0].slice(0, 160)}`);
      }
    } else if (m.type === 'result') {
      if (m.subtype === 'success') {
        if (m.structured_output === undefined) throw new Error('The engineer answered without a plan.');
        return { answer: m.structured_output, model, auth, turns: m.num_turns, ms: Date.now() - t0, toolCalls };
      }
      throw new Error(`The engineer stopped: ${m.subtype}${m.errors?.length ? ` (${m.errors.join('; ')})` : ''}`);
    }
  }
  throw new Error('The engineer ended without an answer.');
}
