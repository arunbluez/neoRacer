// The only host globals the portable core may use. They exist in browsers,
// React Native (Hermes) and Node alike. Everything else comes in through the
// interfaces in core/types.ts.
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(handler: () => void, ms?: number): unknown;
declare function clearInterval(handle: unknown): void;
declare function queueMicrotask(cb: () => void): void;
