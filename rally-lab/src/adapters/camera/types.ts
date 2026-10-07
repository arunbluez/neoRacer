import type { FrameSource } from '../../core/types';
import type { ImageBuf } from '../../core/vision/rectify';

export type CameraInfo = { deviceId: string; label: string };

export type LockResult = { applied: Record<string, unknown>; failed: Record<string, string>; settings: Record<string, unknown> | null };

/** A FrameSource with what the Camera screen needs on top. */
export interface CameraSource extends FrameSource {
  readonly kind: 'camera' | 'sim';
  readonly label: string;
  readonly deviceId?: string;
  /** Element showing the live picture (video or canvas). */
  readonly preview: HTMLElement;
  /** Full-resolution size of the camera picture. */
  readonly size: { w: number; h: number };
  /** Frames skipped by the browser (callback too slow). */
  readonly dropped: number;
  captureStill(): Promise<{ img: ImageBuf; jpeg: Uint8Array }>;
  capabilities(): Record<string, unknown> | null;
  settings(): Record<string, unknown> | null;
  setZoom(z: number): Promise<void>;
  lockExposure(): Promise<LockResult>;
}
