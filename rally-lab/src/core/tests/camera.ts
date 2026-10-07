// What camera-based tests and camera-measured motion tests need from the
// tracking pipeline. The UI layer implements these on top of a FrameSource.

export type TrackedPose = {
  /** Clock time of the frame (same base as link timestamps), ms. */
  tFrame: number;
  xCm: number;
  yCm: number;
  headingDeg: number | null;
  conf: number;
  /** Filtered values. */
  fx: number;
  fy: number;
  fHeadingDeg: number;
  speedCmS: number;
};

export type FrameStat = { tFrame: number; procMs: number; detected: boolean; candidates: number };

export interface PoseSource {
  /** True when calibrated and tracking frames. */
  readonly active: boolean;
  latest(): TrackedPose | undefined;
  /** Poses with tFrame in [t0, t1]. */
  between(t0: number, t1: number): TrackedPose[];
  /** Per-frame statistics with tFrame in [t0, t1] (includes frames without detection). */
  frames(t0: number, t1: number): FrameStat[];
  /** Wait for the next processed frame. */
  nextFrame(): Promise<FrameStat>;
}

export type MarkerProbe = {
  /** Mean RGB of a small patch around the last marker A position, per frame. */
  tFrame: number;
  r: number;
  g: number;
  b: number;
  found: boolean;
};

export interface CameraControl {
  /** T4.1: getCapabilities()/getSettings() for every camera. */
  dumpCapabilities(): Promise<unknown>;
  /** T4.2: let the user tap points with known mat coordinates. */
  collectPoints(count: number): Promise<{ img: { x: number; y: number }; mat: { x: number; y: number } }[]>;
  /** T4.5: subscribe to the colour seen at the headlight position each frame. */
  probeMarker(cb: (p: MarkerProbe) => void): () => void;
  /** Calibration error check result of the active calibration (cm). */
  readonly calibrationId?: string;
}
