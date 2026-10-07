# Changelog

## M0 — Connect and log (2026-10-07)

- Vite + React 18 + TypeScript (strict) scaffold in `rally-lab/`, PWA manifest and service worker
  (production only), GitHub Pages workflow, dev loop with `adb reverse`.
- Portable core: command builders, reply parser with partial-chunk reassembly, write scheduler
  (all channels, priorities, coalescing, min gap, blocking hold, 20-byte limit, optional packing),
  FIFO reply matcher with timeouts, link stats, reconnect with backoff, poller.
- `WebBluetoothTransport` (name-prefix filter, UART service, indications, write-without-response
  with fallback) and `MockTransport` (firmware emulation, 20-byte receive buffer, latency, jitter,
  loss, 2D world).
- Logger with session ids `YYYYMMDD-HHMMSS-<robotId>`, ring buffer, 1 s flush to IndexedDB (Dexie)
  and to the dev server (`/__log`, `/__artifact`).
- Header strip (link dot, robot id, RTT median, queue, busy, sync, session timer, build id,
  STOP) and Connect and Console screens.
- Tests: 80 Vitest tests (protocol, scheduler, matcher, link end-to-end with the mock, vision).
