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

## M1 — Monitor and link tests (2026-10-07)

- Test framework: definitions with setup text, typed parameters, hard maximum duration, partial
  results on abort, `test.start`/`test.sample`/`test.end` events, stored runs, per-test artifacts,
  STOP guard (a stopped test can send nothing but S).
- Link tests T1.1 ping baseline, T1.2 poll rate sweep, T1.3 write gap sweep, T1.4 packed writes,
  T1.5 blocking commands (derives the per-robot blocking table, incl. TONE overhead and a DISP
  per-character model), T1.6 buffer overflow, T1.7 soak; sensor tests T2.1–T2.6.
- Monitor screen: line squares, RTT sparkline, ultrasonic, accelerometer, light, temperature,
  compass (guarded), poller presets and per-query rates, notes with quick tags.
- Tests screen: cards with params (remembered), setup confirmation, progress, results, Save to
  profile, run history and cross-run tables (e.g. surface survey across labels).
- Data screen: sessions with export (zip via share sheet or download), copy report, delete,
  export all, storage meter with 80 % warning; robot profile editor; settings.
- `report.md` for coding agents (per-test sections, profile, calibrations, open warnings) and
  `session.zip` (session.json, events.jsonl, report.md, images/).
- Tests: end-to-end T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T2.1 and STOP against the mock; report
  snapshot; zip contents.
