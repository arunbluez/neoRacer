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

## M2 — Drive and motion tests (2026-10-07)

- Drive screen: virtual joystick with arcade mixing to `MS,l,r`, speed cap, expo, trim (saved to
  the robot profile, applied to the right wheel), tilt mode with a hold-to-drive button, dead-man
  (lifting the finger sends S), vibration on send failures and disconnects, live line-sensor
  overlay, lap timer (laps logged as notes). Sends at the write gap, only on change plus a 300 ms
  keepalive, so queries still get through; every send is logged as an `input` event.
- Motion tests T3.1 deadband, T3.2 straight speed (speed table and trim suggestion), T3.3 start
  and stop, T3.4 spin rate, T3.5 arcs (radius, speed, effective track width), T3.6 battery check.
  Each uses camera tracking when it is running and asks for tape-measure entry otherwise.
- Portable `model/drive.ts` (mixing, expo, trim, tilt) and `model/fits.ts` (circle fit, steady
  speed, along/sideways split, trim from drift, track width from arcs).
- Tests: drive mixing and fits; T3.1, T3.2, T3.4, T3.5 end to end against the simulated robot with
  a simulated tester entering true measurements (recovers the sim's deadband, right-wheel
  mismatch and track width).

## M3 — Camera (2026-10-07)

- Camera setup: camera picker (remembered), 1280×720 at 30 fps requested and the granted
  settings shown and logged, zoom slider (defaults to widest), lock exposure / white balance /
  focus where supported, live "check" outline of the calibrated mat. `requestVideoFrameCallback`
  capture timestamps, falling back to requestAnimationFrame.
- Track calibration: capture a still, tap the four corners (loupe, draggable), mat size, up to 8
  extra known points, normalised DLT, reprojected outline; saved with the still image.
- Track map: still warped top-down at `mmPerPx` (bilinear), offtrack/border/lane/other
  classification with HSV sliders and live preview, class percentages, map and mask PNGs,
  colour scan with marker hue suggestions, named landmarks.
- Marker calibration: light source + colour for markers A and B, tap to sample, tolerance
  sliders, live mask overlay.
- Tracking: per-frame search windows, largest blob, centroids through H, heading B → A (or from
  velocity), alpha-beta filter, latency prediction, `cam.pose` and `cam.stats` logging, live
  overlay and a top-down mini-map with a speed-coloured trail. ~0.5 ms per 640×360 frame.
- Camera tests T4.1 capabilities, T4.2 calibration check, T4.3 tracking quality, T4.4 frame
  timing, T4.5 LED latency (also sets the tracker's prediction latency), T4.6 motion latency,
  T4.7 tracked lap (trajectory, speed profile, lap time from a start/finish landmark, line codes
  along the path). T3 motion tests use camera measurements when tracking is on.
- Simulated camera for the mock robot, using the viewpoint of a photo of the real track, with
  pose and light history so latencies are realistic.
- From a photo of the real mat: the synthetic track now follows the measured layout (18 cm lane,
  serpentine, arrows, lettering, ramps, bridge, cones), default class thresholds are tuned to
  the real colours (with a regression test on a rectified 1 cm/px picture of the mat), and
  marker B defaults to cyan (hues 80–210° never occur on the mat).

## M4 — Polish (2026-10-07)

- Already in from earlier milestones: T1.7 soak, T2.6 compass (guarded), landmarks,
  speed-coloured trail, storage meter.
- Tracking in a Web Worker (Data → Settings → "Track in a Web Worker"): frames go to the worker
  as transferred ImageBitmaps, so neither the pixel read-back nor the tracker runs on the main
  thread. Frame-grab time is now measured and reported (`cam.stats.grabMs`, T4.4).
- Fix: the camera preview is parked in the page instead of being detached when no screen shows
  it, so tracking keeps running while you use the Tests or Drive tab (a detached video pauses).
- Tracker merges blobs of one marker that lie within 8 cm on the mat (both headlights), so the
  position no longer jumps between the two lights; camera trim suggestions now match the
  simulator's true wheel mismatch.
- Motion tests fall back to manual entry when the camera loses the robot mid-run; trim is weighted
  by run length and ignores runs under 25 cm.
- The mock robot's line sensors read the calibrated track mask when there is one.
- Processing width in Settings; README with a track-day checklist, the measured mat facts, the
  log format and known limits.
