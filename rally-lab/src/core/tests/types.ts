// An experiment is a definition with setup text, parameters with defaults,
// a runner and a summary function. Runs are logged (test.start/sample/end)
// and stored, and their summaries go into report.md.

import type { RobotLink } from '../link/link';
import type { Poller } from '../link/poller';
import type { RobotProfile } from '../model/profile';
import type { Settings } from '../settings';
import type { CancelToken } from '../util/async';
import type { PoseSource, CameraControl } from './camera';

export type TestGroup = 'Link' | 'Sensors' | 'Motion' | 'Camera';

export type ParamDef =
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number; unit?: string; help?: string }
  | { key: string; label: string; type: 'numbers'; default: number[]; unit?: string; help?: string }
  | { key: string; label: string; type: 'select'; default: string; options: string[]; help?: string }
  | { key: string; label: string; type: 'multi'; default: string[]; options: string[]; help?: string }
  | { key: string; label: string; type: 'text'; default: string; help?: string }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string };

export type Params = Record<string, number | number[] | string | string[] | boolean>;

/** A small table for the result card and report.md. */
export type ResultTable = { title?: string; columns: string[]; rows: (string | number | null)[][] };

export type TestSummary = {
  /** Headline numbers, already rounded. */
  values: Record<string, number | string | boolean | null>;
  tables: ResultTable[];
  /** One-line verdicts and warnings for the report. */
  notes: string[];
  /** Values the user can save into the robot profile. */
  profilePatch?: Partial<RobotProfile>;
  /** Settings the user can apply (e.g. measured tracking latency). */
  settingsPatch?: Partial<Settings>;
};

export type TestRun = {
  runId: string;
  testId: string;
  title: string;
  sessionId: string;
  robotId?: string;
  startedAt: string;
  /** Session time, ms. */
  tStart: number;
  tEnd?: number;
  params: Params;
  status: 'running' | 'done' | 'aborted' | 'error';
  error?: string;
  data: unknown;
  summary?: TestSummary;
  /** Whether results came from the camera or manual entry, where relevant. */
  measuredBy?: 'camera' | 'manual' | 'robot';
};

export type PromptField =
  | { key: string; label: string; type: 'number'; default?: number; unit?: string; hint?: string }
  | { key: string; label: string; type: 'text'; default?: string; hint?: string }
  | { key: string; label: string; type: 'select'; options: string[]; default?: string };

export type PromptRequest = {
  title: string;
  text?: string;
  fields?: PromptField[];
  /** Buttons; the first is the primary action. Defaults to ['Next']. */
  buttons?: string[];
  /** A prompt that stays open while the test keeps running (e.g. a "Moving" tap button). */
  live?: boolean;
  /** Show it as a strip under the header on every screen instead of a dialog (e.g. a lap in progress). */
  banner?: boolean;
};

export type PromptResponse = { button: string; values: Record<string, number | string> };

export interface PromptHandle {
  /** Resolves when the user presses a button. */
  readonly result: Promise<PromptResponse>;
  /** Button presses so far (for live prompts). */
  readonly taps: { button: string; t: number }[];
  close(): void;
}

export interface TestUi {
  prompt(req: PromptRequest): PromptHandle;
}

export type Progress = { fraction: number; text?: string };

export interface TestContext {
  link: RobotLink;
  poller: Poller;
  token: CancelToken;
  settings: Settings;
  profile?: RobotProfile;
  ui: TestUi;
  /** Camera tracking, when calibrated and running. */
  pose?: PoseSource;
  camera?: CameraControl;
  /** Session time now, ms. */
  now(): number;
  /** Clock time now (same base as link timestamps), ms. */
  clockNow(): number;
  sleep(ms: number): Promise<void>;
  progress(fraction: number, text?: string): void;
  /** Log a test.sample event. */
  sample(data: Record<string, unknown>): void;
  /** Ask the user and wait; throws when the test is aborted. */
  ask(req: PromptRequest): Promise<PromptResponse>;
  /** Summaries of earlier runs in this session, newest first. */
  previousRuns(testId: string): TestRun[];
  /** Save a JSON artifact for this run (dev sync + export). */
  artifact(name: string, data: unknown): void;
  /** Remember partial results; an aborted run is summarised from the last kept data. */
  keep(data: unknown): void;
}

export type TestDefinition = {
  id: string;
  group: TestGroup;
  title: string;
  /** Setup text shown before Start. */
  setup: string;
  params: ParamDef[];
  needs: { robot: boolean; motion?: boolean; wheelsUp?: boolean; camera?: boolean; tracking?: boolean };
  /** Hard maximum duration, ms. The runner aborts the test after it. */
  maxMs: number;
  run(ctx: TestContext, params: Params): Promise<unknown>;
  summarize(data: unknown, params: Params, ctx: Pick<TestContext, 'profile' | 'settings'>): TestSummary;
  /** Optional: one table across all runs of this test in a session (e.g. surface survey). */
  aggregate?(runs: TestRun[]): ResultTable | null;
};

export function defaultParams(def: TestDefinition): Params {
  const p: Params = {};
  for (const d of def.params) p[d.key] = d.default;
  return p;
}
