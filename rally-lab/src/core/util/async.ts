// Cancellation and sleeping for long-running core tasks (tests, pollers).

export class AbortedError extends Error {
  constructor(reason = 'aborted') {
    super(reason);
    this.name = 'AbortedError';
  }
}

export class CancelToken {
  private _reason: string | null = null;
  private listeners = new Set<(reason: string) => void>();

  get aborted(): boolean {
    return this._reason !== null;
  }

  get reason(): string | null {
    return this._reason;
  }

  abort(reason = 'aborted'): void {
    if (this._reason !== null) return;
    this._reason = reason;
    for (const cb of [...this.listeners]) cb(reason);
    this.listeners.clear();
  }

  onAbort(cb: (reason: string) => void): () => void {
    if (this._reason !== null) {
      cb(this._reason);
      return () => {};
    }
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  throwIfAborted(): void {
    if (this._reason !== null) throw new AbortedError(this._reason);
  }
}

export function sleep(ms: number, token?: CancelToken): Promise<void> {
  return new Promise((resolve, reject) => {
    if (token?.aborted) return reject(new AbortedError(token.reason ?? undefined));
    let off = () => {};
    const h = setTimeout(() => {
      off();
      resolve();
    }, Math.max(0, ms));
    if (token) {
      off = token.onAbort((reason) => {
        clearTimeout(h);
        reject(new AbortedError(reason));
      });
    }
  });
}

/** Resolves with the promise's value, or rejects when the token aborts first. */
export function abortable<T>(p: Promise<T>, token?: CancelToken): Promise<T> {
  if (!token) return p;
  return new Promise<T>((resolve, reject) => {
    const off = token.onAbort((reason) => reject(new AbortedError(reason)));
    p.then(
      (v) => {
        off();
        resolve(v);
      },
      (e) => {
        off();
        reject(e);
      },
    );
  });
}

export function isAborted(err: unknown): err is AbortedError {
  return err instanceof AbortedError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
