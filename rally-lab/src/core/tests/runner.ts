// Runs one experiment at a time: logs it, enforces its hard maximum
// duration, restores pollers and scheduler settings, always ends motion
// tests with S, and stores the run with its summary.

import type { RobotLink } from '../link/link';
import type { Poller } from '../link/poller';
import type { Logger } from '../log/logger';
import type { RobotProfile } from '../model/profile';
import type { Settings } from '../settings';
import type { Clock } from '../types';
import { abortable, CancelToken, errorMessage, isAborted, sleep } from '../util/async';
import type { CameraControl, PoseSource } from './camera';
import type {
  Params, Progress, PromptRequest, PromptResponse, TestContext, TestDefinition, TestRun, TestUi,
} from './types';

export type RunnerDeps = {
  link: RobotLink;
  poller: Poller;
  logger: Logger;
  clock: Clock;
  ui: TestUi;
  settings: () => Settings;
  profile: () => RobotProfile | undefined;
  pose?: () => PoseSource | undefined;
  camera?: () => CameraControl | undefined;
  saveRun: (run: TestRun) => Promise<void>;
  artifact?: (path: string, data: unknown) => void;
  wallClock: () => Date;
};

export type RunnerState = {
  run?: TestRun;
  def?: TestDefinition;
  progress: Progress;
};

export class TestRunner {
  private current: { def: TestDefinition; run: TestRun; token: CancelToken; progress: Progress } | null = null;
  private listeners = new Set<(s: RunnerState) => void>();
  /** Runs finished in this session, newest first. */
  history: TestRun[] = [];
  private counter = 0;

  constructor(private readonly deps: RunnerDeps) {}

  get running(): boolean {
    return this.current !== null;
  }

  get state(): RunnerState {
    const c = this.current;
    return c ? { run: c.run, def: c.def, progress: c.progress } : { progress: { fraction: 0 } };
  }

  subscribe(cb: (s: RunnerState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Forget the history (new session). */
  resetHistory(runs: TestRun[] = []): void {
    this.history = [...runs].sort((a, b) => b.tStart - a.tStart);
    this.emit();
  }

  abort(reason = 'stopped'): void {
    this.current?.token.abort(reason);
  }

  private emit(): void {
    const s = this.state;
    for (const cb of this.listeners) cb(s);
  }

  async run(def: TestDefinition, params: Params): Promise<TestRun> {
    if (this.current) throw new Error(`${this.current.def.id} is still running`);
    const { link, poller, logger, clock } = this.deps;
    const token = new CancelToken();
    const tStart = logger.now();
    const runId = `${def.id}-${Math.round(tStart)}-${++this.counter}`;
    const run: TestRun = {
      runId,
      testId: def.id,
      title: def.title,
      sessionId: logger.sessionId,
      robotId: this.deps.profile()?.robotId,
      startedAt: this.deps.wallClock().toISOString(),
      tStart,
      params,
      status: 'running',
      data: null,
    };
    this.current = { def, run, token, progress: { fraction: 0 } };
    this.emit();
    logger.log('test.start', { testId: def.id, runId, params, title: def.title });

    const savedPoller = poller.set([], `test:${def.id}`);
    const savedSched = { ...link.scheduler.config };
    const openPrompts = new Set<{ close(): void }>();
    let kept: unknown = null;
    const hardStop = setTimeout(() => token.abort(`hard maximum of ${Math.round(def.maxMs / 1000)} s reached`), def.maxMs);

    // After STOP the test may not send anything but S, whatever its code does next.
    const guarded = new Proxy(link, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== 'function') return v;
        if (prop === 'send' || prop === 'query' || prop === 'repliesOf') {
          return (...args: unknown[]) => {
            token.throwIfAborted();
            return abortable((v as (...a: unknown[]) => Promise<unknown>).apply(target, args), token);
          };
        }
        return (v as (...a: unknown[]) => unknown).bind(target);
      },
    });
    const ctx: TestContext = {
      link: guarded,
      poller,
      token,
      settings: this.deps.settings(),
      profile: this.deps.profile(),
      pose: this.deps.pose?.(),
      camera: this.deps.camera?.(),
      ui: {
        prompt: (req: PromptRequest) => {
          const h = this.deps.ui.prompt(req);
          openPrompts.add(h);
          void h.result.finally(() => openPrompts.delete(h));
          return h;
        },
      },
      now: () => logger.now(),
      clockNow: () => clock.now(),
      sleep: (ms) => sleep(ms, token),
      progress: (fraction, text) => {
        if (!this.current) return;
        this.current.progress = { fraction: Math.max(0, Math.min(1, fraction)), text };
        this.emit();
      },
      sample: (data) => {
        logger.log('test.sample', { testId: def.id, runId, data });
      },
      ask: async (req): Promise<PromptResponse> => {
        token.throwIfAborted();
        const h = ctx.ui.prompt(req);
        try {
          return await abortable(h.result, token);
        } finally {
          h.close();
        }
      },
      previousRuns: (testId) => this.history.filter((r) => r.testId === testId),
      artifact: (name, data) => this.deps.artifact?.(`tests/${runId}/${name}`, data),
      keep: (data) => {
        kept = data;
      },
    };

    let data: unknown = null;
    try {
      token.throwIfAborted();
      data = await def.run(ctx, params);
      run.status = 'done';
    } catch (err) {
      data = kept;
      if (isAborted(err) || token.aborted) {
        run.status = 'aborted';
        run.error = token.reason ?? errorMessage(err);
      } else {
        run.status = 'error';
        run.error = errorMessage(err);
      }
    } finally {
      clearTimeout(hardStop);
      for (const p of openPrompts) p.close();
      if (def.needs.motion || def.needs.wheelsUp) void link.stop();
      link.scheduler.setConfig(savedSched);
      poller.set(savedPoller.entries, savedPoller.source);
    }

    run.data = data;
    run.tEnd = logger.now();
    if (data !== null && data !== undefined) {
      try {
        run.summary = def.summarize(data, params, { profile: this.deps.profile(), settings: this.deps.settings() });
        if (run.status !== 'done') run.summary.notes.unshift(`Partial result: ${run.status} (${run.error}).`);
      } catch (err) {
        run.summary = { values: {}, tables: [], notes: [`Summary failed: ${errorMessage(err)}`] };
      }
    }
    logger.log('test.end', {
      testId: def.id, runId, status: run.status, error: run.error, durMs: Math.round(run.tEnd - run.tStart),
      summary: run.summary, data,
    });
    this.current = null;
    this.history.unshift(run);
    try {
      await this.deps.saveRun(run);
    } catch (err) {
      logger.log('app', { event: 'error', detail: `saving test run failed: ${errorMessage(err)}` });
    }
    this.deps.artifact?.(`tests/${runId}.json`, run);
    this.emit();
    return run;
  }
}
