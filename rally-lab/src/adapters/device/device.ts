// Small device adapters: screen wake lock, vibration, page visibility,
// device orientation and wall-clock/environment info.

export class WakeLockKeeper {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  constructor(private readonly log: (event: string, detail: unknown) => void) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted && !this.sentinel) void this.acquire();
    });
  }

  get held(): boolean {
    return this.sentinel !== null;
  }

  async set(wanted: boolean): Promise<void> {
    this.wanted = wanted;
    if (wanted) await this.acquire();
    else await this.release();
  }

  private async acquire(): Promise<void> {
    if (this.sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.log('wakelock', 'acquired');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.log('wakelock', 'released');
      });
    } catch (err) {
      this.log('wakelock', `failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async release(): Promise<void> {
    const s = this.sentinel;
    this.sentinel = null;
    if (s) await s.release().catch(() => {});
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // not supported
  }
}

export function onVisibility(cb: (hidden: boolean) => void): () => void {
  const h = () => cb(document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', h);
  window.addEventListener('pagehide', () => cb(true));
  return () => document.removeEventListener('visibilitychange', h);
}

export type Tilt = { beta: number; gamma: number; t: number };

/** Device tilt for tilt driving. On Android Chrome no permission prompt is needed. */
export function onTilt(cb: (t: Tilt) => void): () => void {
  const h = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    cb({ beta: e.beta, gamma: e.gamma, t: performance.now() });
  };
  window.addEventListener('deviceorientation', h);
  return () => window.removeEventListener('deviceorientation', h);
}

export function environment() {
  return {
    buildId: __BUILD_ID__,
    buildTime: __BUILD_TIME__,
    userAgent: navigator.userAgent,
    screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio },
  };
}
