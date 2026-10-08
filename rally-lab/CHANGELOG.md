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

## Field fixes (2026-10-07, after the first session with robot puguz)

- Drive: the stick now starts at each wheel's measured deadband (commands below ~15–20 don't move
  a wheel, which made the stick feel dead and then twitchy), a centre dead zone, a turn
  sensitivity slider, gentler defaults (cap 50, expo 0.3, turn 0.5), and trim per speed.
- T3.2 saves a trim per speed; new **T3.7 straight check** drives exactly like the Drive tab and
  corrects the trim from the measured drift.
- T3.4 asks for turns instead of degrees.
- Tests abort when the robot disconnects; a test waiting for a typed measurement survives the page
  being hidden; the hard maximum doesn't count time spent waiting for the user.
- T1.5 uses `TONE,440,150` (a 500 ms tone dropped the link) and says when the link dropped.
- Camera: 4:3 frames by default, a portrait warning, landscape allowed in the installed app,
  tracking pauses when the picture shape no longer matches the calibration, white-balance and
  focus lock retry with in-range values, hints when Chrome hides the ultra-wide camera.
- docs/field-notes-2026-10-07.md: what the logs measured.

## Auto run with a hand-held camera (2026-10-07)

- **Auto** tab: drives the measured route with the phone camera held by hand. Mat finder
  (`vision/matFinder.ts`: dark region with holes filled, robust edge lines, sub-pixel refinement,
  corner identity kept frame to frame), orientation from the lane pattern, phone position and
  focal length from the mat's perspective, and the lights' height corrected (`vision/matView.ts`,
  `vision/handheld.ts`).
- Track code (`race/route.ts`): sections a–g as described at the venue, measured on a rectified
  photo of the mat; arc turns, or spins on the spot in 45° steps for the slowest speeds; sideways
  offsets around the cones on c. Editable in the app.
- Estimator (`race/estimator.ts`): Kalman filter on the axle pose from the wheel commands and the
  camera fixes, folding late fixes in at their capture time, learning turning bias, speed scale
  and turn scale. Follower (`race/follower.ts`): curvature steering with every moving wheel above
  its deadband (right wheel with its trim), speed raised in tight arcs, timed spins. Run
  (`race/autoRun.ts`): 25 Hz control, line-sensor guard, off-track stop, STOP/page hidden/
  disconnect stop it, full logging and an "Auto runs" section in report.md.
- Full-screen run view (camera, route overlay, Start/STOP); map of the mat with the camera fixes
  and the estimate; track editor; tuning.
- Simplified tab bar: Connect, Drive, Auto, Data; lab tools behind Data → Settings → Lab tools.
- Simulator: the synthetic mat is now the measured 200 × 300 cm track; a hand-held simulated phone
  camera (`sim/camera.ts`); the mock robot behaves like puguz.
- Tests: mat finder from four sides, with clutter and shake; camera pose; parallax; route closure
  and cone offsets; estimator and motor model; closed-loop laps (`testing/simLap.ts`); two full
  camera-assisted laps through the mock link and rendered frames; the route on the venue photo.
- docs/track.md: the track, its coordinates and the track code.
- Turns follow the lane's curves by default ("Follow the curves"); spinning on the spot is the
  option. Settings saved before switch over once.

## Auto run, first field feedback (2026-10-07)

- The track is found by its lane, not the mat's outline (`vision/laneFit.ts`): lane-coloured
  pixels, their edges, and a robust homography fit with edge polarity (outer edges can't lock onto
  inner ones), started from the last frame, the lane band's straight outer edges, the mat outline
  and restarts. Works with dark clothes, bags and chairs against the mat (the outline finder merged
  them in), and without the mat's edges in view, so the phone can be closer; best from a long side.
  Checked on a frame from the venue.
- All four lights in one colour (green, cyan or yellow); the robot is searched only near where it
  should be (the start line, where the blink test found it, the estimate during a run), so other
  robots' lights don't count. **Find my robot** blinks the lights and picks the light that blinked
  along (`vision/blinkFinder.ts`); Start runs it when needed.
- Full screen: big Close, Find my robot and Re-detect track buttons. The camera's zoom range is
  shown and logged (no ultra-wide on phones where Chrome offers only one back camera).

## Auto run, second field test (2026-10-08)

- Lost robot: when the camera hasn't seen the robot for 1 s (4 s around the bridge), the robot
  holds still and the camera searches along the route back to where it last saw it. Found, the
  estimate moves there with the route's heading (keeping the learned motor numbers) and the
  follower picks the route up there; after any big camera correction the follower re-finds its
  place too. Gives up after 8 s. In the field the robot got stuck on a cone after the bridge, the
  estimate drove on, and the camera kept looking around the estimate, never where the robot was.
- Stuck: the camera seeing the robot not move for 1.5 s while it is driven stops the run.
- Cone dodges on c: 4.5 cm each way (was 2.5 and 3.5), ramps 25 cm (was 15) so the swap between
  the cones is a ~22 cm radius bend instead of a 5–8 cm one; sliders on the Auto screen to move them.
- Logged: `auto.lost`, `auto.found`, `auto.resync`; holds in the summary.

## Lap tuning and the race engineer (2026-10-08)

- Lap tuning (`race/tuning.ts`): per-section straight and turn speeds, acceleration, braking,
  grip and steering distance; limits, and a 25 % cap on any rise per step. Without a tuning the
  robot drives the constant speeds exactly as before.
- Speed profile (`race/speedProfile.ts`): target speed along the plan from the tuning (forward
  pass for acceleration, backward pass for braking, grip limit in turns, the deadband and the
  inner wheel's needs as floors), read slightly ahead by the follower; predicted lap time per
  section. A simulated lap with straights at 50 cm/s takes 19.9 s against 29.7 s at a constant
  30 cm/s, 19.6 s predicted.
- Lap analysis (`race/lapAnalysis.ts`): every auto run from the log, each section split into
  straights and turns (time, speed, distance off the path, heading error, line events, camera
  fixes, corrections and gaps), where it stopped.
- Quick tune (`race/learner.ts`): the next tuning by rules from the last run.
- Race engineer: `race/engineerBrief.ts` (what Claude is told, its tools, the answer's schema),
  `race/engineerPlan.ts` (the plan file, reading it back from a file or a pasted message, checks,
  track code edits within 15 % / 15 cm), and the laptop command `engineer/` (Claude Agent SDK on
  the Claude Code login, default model Haiku 5.5, tools `predict_lap` and `section_trace`,
  structured output; `--offline`, `--dry-run`, `--watch`).
- Auto screen: Lap tuning card (tuning, predicted times, runs, Quick tune, Send runs to the
  engineer, Load/Paste plan, Copy brief for the Claude app, review before Apply, Undo, Keep for
  the race). The speed slider gives way to the tuning while one is set.
- Run summary: tuning, predicted time, line events per section.
