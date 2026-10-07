# Rally Lab — PRD

Oct 7, 2026 · @Arunkumar

## Summary

Rally Lab is a React PWA for Android Chrome that connects to the Cutebot over Web Bluetooth and measures everything the race app will depend on. It covers link latency, sensor behaviour on the real track, motion characteristics, and a camera-based track map with robot tracking.

It is a lab instrument, not the race app. Every reading is timestamped, logged and exported as JSON, so a coding agent can build the race controller from measured facts instead of guesses. All logic lives in portable TypeScript so the race app can later move to React Native.

Success by Wednesday evening, 7 Oct 2026:

- The phone connects to a robot in under 10 s and the monitor shows live round-trip time.
- The surface survey has line-sensor readings for every surface on the track.
- Link tests give a safe command rate and the real blocking time of each firmware command.
- A calibrated top-down track map and at least one tracked manual lap are exported.

## Context

The race is decided by adjusted lap time: raw time minus up to 30 s of judge-awarded bonuses, with one timed attempt in the final on Friday 9 Oct at 14:30. Shared robots never leave the track area.

### Track (from a photo; measure on site)

- A printed mat, roughly 3 × 2.5 m. A coloured lane with a blue → purple → pink gradient, white border lines, black background.
- Route: from the checkered start/finish at top left, go left, down the left side through a wooden truss bridge, right along the bottom straight past red cones, up the right side, then through a serpentine with several hairpins back to the finish.
- Red and white cones sit near the hairpin apexes and on the bottom straight. Two wooden ramps lie in the infield. Whether they are on the final course is unknown.

### Hardware

- BBC micro:bit V2 on an Elecfreaks Cutebot V3.6, 3 × AAA alkaline batteries, ultrasonic sensor at the front.
- Two IR line sensors under the front near the ball caster (pins P13, P14), digital output only.
- Two RGB headlights at the front, two underglow NeoPixels (pin P15).
- No wheel encoders and no gyroscope. Accelerometer and magnetometer are on the micro:bit.
- Each robot advertises as `BBC micro:bit [xxxxx]`, a 5-letter id; the label also shows the MAC (example: `[popuv]`, CD:97:34:9F:97:C1).

### Firmware facts (from `microbitapi.js`; tests confirm)

- Nordic UART service. The phone writes to RX `6E400003`; the robot replies on TX `6E400002` using indications. No pairing required.
- Commands end with `#`, replies end with `#\n`. Each command runs in one handler call, and handler calls run one at a time.
- On disconnect the robot stops motors, turns lights off and shows a sad face. That is the only failsafe: if the app freezes while connected, the robot keeps its last motor command.
- Expected blocking commands: `ICON` about 600 ms, `HORN` 200 ms, `BEEP` 100 ms, `TONE` its duration, `DISP` several seconds of scrolling. Commands arriving meanwhile wait in a small receive buffer and may be dropped or garbled.
- `?COMPASS` on an uncalibrated micro:bit starts the tilt-to-fill-screen calibration and blocks until someone completes it.
- `ML` and `MR` keep the other wheel's last speed. `F`, `B`, `L`, `R` default to speed 50.
- Each query gets one reply; nothing streams. Replies carry no request id.
- The line-sensor codes assume a black line on white. On this mat the coloured lane may read as white in infrared, so the surface survey (T2.1) decides how the sensors can be used.

### Repo

`droidconHQ/CuteBotDriver` holds `microbitapi.js` (source of truth for robot behaviour), `ReactNativeApi.ts` (parsing logic to reuse) and a React Native sample with no native folders.

## Scope

Rally Lab measures and logs; it does not race.

Goals:

1. Connect to, control and log a Cutebot from Android Chrome by opening a URL, with nothing to install.
2. Run repeatable experiments with on-screen instructions and store labelled results.
3. Calibrate the track from the phone camera and track the robot's position and heading on the mat.
4. Log every packet and measurement continuously and export it for a coding agent.
5. Keep all logic in portable TypeScript so the race app can move to React Native.

Non-goals:

- The race autopilot, racing UI and bonus showcase (light shows, sounds). These belong to the race app built from this app's data.
- iOS support (Safari has no Web Bluetooth).
- Re-flashing or modifying the robot firmware.
- Several robots connected at once.

Usage scenarios:

- At the laptop: phone on USB, dev server through `adb reverse`, logs stream into the repo.
- At the track, untethered: app served from GitHub Pages, logs kept in IndexedDB, exported afterwards.
- Robot on a stand with wheels in the air for link tests; on the mat for sensor and motion tests.
- Phone on a tripod at the mat's edge for camera tests; in hand for everything else.

Constraints:

- Chrome on Android only. Bluetooth, camera and orientation sensors need HTTPS or localhost.
- Track time is shared with other teams: every test runs in under 60 s and repeats with one tap.
- One-handed use: touch targets at least 48 px, dark theme, STOP reachable from every screen.

## Tech stack and architecture

Vite + React 18 + TypeScript, built as a PWA in `rally-lab/` at the repo root. Core logic is plain TypeScript with no DOM or React imports, so it moves to React Native unchanged; only the adapters are rewritten.

&#91;embedded content: Rally Lab architecture · UI, portable core, adapters, robot and laptop\]

Only the adapters touch browser APIs, so porting to React Native means rewriting that bottom layer and keeping the core as is.

### Stack

- Vite, React 18, TypeScript in strict mode; simple tab navigation (no router needed).
- Zustand for app state (also works in React Native).
- Dexie over IndexedDB for storage; fflate for zip export.
- Live charts with uPlot or hand-rolled canvas; no heavy chart library.
- vite-plugin-pwa: manifest (standalone, portrait, dark) and a service worker in production builds only. No service worker in dev, to avoid stale code.
- Vitest for unit tests. ESLint `no-restricted-imports` blocks DOM, browser globals and React inside `src/core`.
- No OpenCV: homography, warping and blob detection are small TypeScript functions.

### Folders

```
rally-lab/
  src/core/          portable: no DOM, no React
    protocol/        command builders, reply parser (port of ReactNativeApi.ts)
    link/            write scheduler, reply matcher, blocking table, link stats
    log/             event types, session, ring buffer, report builder
    tests/           experiment definitions and runners
    vision/          homography, rectify, colour classify, blob tracker, pose filter
    model/           robot profile, motion model fits
  src/adapters/      platform-specific
    ble/             WebBluetoothTransport, MockTransport
    storage/         Dexie implementation of LogStore
    camera/          getUserMedia frame source
    device/          wake lock, vibration, device orientation
  src/ui/            React screens and components
  vite-plugins/      dev-only /__log and /__artifact endpoints
  logs/              dev sync output (git-ignored)
```

### Interfaces (defined in core, implemented in adapters)

```ts
interface Transport {
  connect(): Promise<{ name: string; id: string }>;
  disconnect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>; // resolves when the GATT write completes
  onData(cb: (chunk: Uint8Array, tMs: number) => void): () => void;
  onState(cb: (s: 'connecting' | 'connected' | 'disconnected', reason?: string) => void): () => void;
}
interface Clock { now(): number }          // performance.now() on web
interface LogStore { append(batch: LogEvent[]): Promise<void> /* + sessions, queries, export */ }
interface FrameSource {
  start(opts: CameraOpts): Promise<void>;
  onFrame(cb: (f: Frame) => void): () => void;
  stop(): void;
}
type Frame = { width: number; height: number; data: Uint8ClampedArray; tCaptureMs: number };
```

### Performance rules

- High-rate data (packets, samples, poses) never goes through React state. It lives in ring buffers in core; screens read it at 10 Hz or draw on a canvas with requestAnimationFrame.
- No `console.log` in hot paths; use the logger.
- Vision runs on frames scaled to 640 px wide. Move it into a Web Worker if a frame takes over 15 ms.

### Dev loop and deploy

- `npm run dev` plus `adb reverse tcp:5173 tcp:5173`; the phone opens `http://localhost:5173`, which Chrome treats as secure. Use `chrome://inspect` on the laptop for the phone's console.
- Production: a GitHub Actions workflow builds to GitHub Pages (HTTPS), so the phone works away from the laptop. Vite `base` = the repo path.
- The header shows the build id (git short hash and build time). In production, a "Reload new version" button appears when the service worker finds an update.

## Bluetooth link

All robot traffic goes through one transport, one write scheduler and one reply matcher, and every byte is logged.

### Connect

- `navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'BBC micro:bit' }], optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] })`. The robot does not advertise the UART service, so filter by name and list the service as optional.
- Get RX `6e400003-b5a3-f393-e0a9-e50e24dcca9e` (write) and TX `6e400002-b5a3-f393-e0a9-e50e24dcca9e` (indicate). Call `startNotifications()` on TX; it also handles indications.
- Write with `writeValueWithoutResponse`. If the characteristic rejects it, fall back to `writeValueWithResponse` and log which mode is in use.
- Encode with TextEncoder and decode with TextDecoder. Buffer partial chunks, split replies on `#`, trim `\n`.
- Log the connect duration and robot name; the robot id is the 5 letters inside the brackets.

### Write scheduler (the only writer)

- Chrome allows one GATT operation at a time. Keep exactly one write in flight; the next starts when the previous resolves.
- Minimum gap between writes: setting `minWriteGapMs`, default 30. Tests T1.2 and T1.3 find the real value.
- Every write is at most 20 bytes; longer commands are rejected with an error.
- Channels, highest priority first:
  1. `safety`: `S`. Clears the motor channel and jumps the queue.
  2. `motor`: latest wins; a newer motor command replaces an unsent one.
  3. `query`: polled queries; an unsent duplicate of the same query is dropped.
  4. `light`: one slot per light command (`HL`, `HLL`, `HLR`, `UG`, `UGL`, `UGR`), latest wins.
  5. `oneshot`: everything else, first in first out.
  6. `raw`: console input, first in first out, never coalesced.
- Packing: setting `packWrites` (default off) joins short commands into one write when the total is at most 20 bytes. Turn it on only after T1.4 proves the firmware handles it.
- Log per write: command, channel, bytes, time enqueued, time sent, time resolved.

### Blocking guard

- A table maps commands to expected block time in ms: `ICON` 600, `HORN` 200, `BEEP` 100, `TONE` its duration, `DISP` (characters × 6 + 5) × 150, everything else 0. T1.5 results override these values per robot.
- After a blocking command, the scheduler holds every channel except `safety` for that time plus 20 ms. The header shows "robot busy".
- `?COMPASS` stays disabled until the robot profile has `compassCalibrated: true`, which the user sets after doing the tilt calibration once. Sending it otherwise needs a confirm dialog.

### Reply matcher

- Replies carry no ids, so match first-in-first-out per type: each sent query pushes its timestamp onto that type's queue, and each reply pops the oldest. `PING` ↔ `PONG`, `?LINE` ↔ `LINE:`, and so on.
- Round-trip time = reply time − write-resolved time. Also log reply time − enqueue time.
- A query without a reply after `replyTimeoutMs` (default 500) counts as lost and is popped.
- Unknown or garbled replies are logged as `raw`.

### Pollers

A poller sends a set of queries at fixed rates through the `query` channel, for example `?LINE` at 20 Hz, `?ACCEL` at 5 Hz and `PING` at 2 Hz. Screens and tests set their own poller presets.

### Reconnect

- On `gattserverdisconnected`, log the reason and time, then reconnect with the same BluetoothDevice object, backing off 0.25, 0.5, 1 and 2 s, at most 10 tries. Re-subscribe to TX and log the time to reconnect.
- A page reload loses the device object; the user taps Connect again.

### Safety

- STOP on every screen sends `S` through `safety` and aborts any running test.
- Every motion test ends with `S` and has a hard maximum duration.
- When the page becomes hidden: send `S`, stop tests and pollers.
- Hold a Screen Wake Lock while connected; re-acquire it when the page is visible again.
- Manual drive uses a dead-man: lifting the finger sends `S`.

### Link stats (shown in the header and Monitor)

Round-trip time last, median and p95 over 10 s; writes per second; replies per second; queue depth per channel; lost replies; write errors; reconnect count; busy state.

## Logging and data

Everything that happens is an event in one append-only log per session, so any run can be replayed and analysed later. Logging is always on; there is no way to turn it off.

### Event shape

```ts
type LogEvent = {
  t: number;   // ms since session start, from performance.now()
  k: string;   // kind, see table
  [field: string]: unknown;
};
```

| Kind | Fields | When |
| --- | --- | --- |
| `ble.tx` | cmd, ch, bytes, tEnq, tSent, tDone | every write |
| `ble.rx` | raw | every reply line |
| `ble.state` | state, reason, durMs | connect, disconnect, reconnect |
| `ble.err` | op, message | any Bluetooth error |
| `sensor` | type, value, rttMs | every parsed reply |
| `link.stats` | rttMed, rttP95, txps, rxps, lost, queue | once per second |
| `input` | mode, left, right, raw | drive input, at send rate |
| `cam.stats` | fps, procMs, dropped | once per second |
| `cam.pose` | xCm, yCm, headingDeg, conf, tFrame, raw | every tracked frame |
| `test.start`, `test.sample`, `test.end` | testId, runId, params, data, summary | test runs |
| `note` | text, tags | user notes |
| `app` | event, detail | visibility, wake lock, errors, version |

### Session

- Starts on app open or "New session". Id: `YYYYMMDD-HHMMSS-<robotId>`.
- Header: schemaVersion, wall-clock start (ISO), build id, user agent, screen size, robot name and id, settings snapshot, robot profile snapshot, active calibration id.

### Storage

- An in-memory ring buffer flushes to IndexedDB every 1 s and whenever the page is hidden.
- Dexie table `events` indexed by `[sessionId+t]`. Sessions, test runs, robot profiles, calibrations and images (as Blobs) get their own tables.
- The Data screen shows storage use and warns above 80 % of the quota.

### Live sync to the laptop (dev only)

- A Vite plugin adds `POST /__log` to the dev server. When the dev server answers, the app sends event batches every 1 s and the plugin appends them to `logs/<sessionId>.jsonl`.
- `POST /__artifact` writes test results, calibration JSON and PNG images to `logs/<sessionId>/`.
- The header shows sync state: green syncing, grey no dev server, red failing.

### Export

- Per session or all sessions: `session.zip` with `session.json` (header, robot profile, calibrations, test results), `events.jsonl`, `report.md` and `images/` (calibration still, rectified map, track mask).
- `report.md` is written for a coding agent: one section per test with its parameters, summary numbers and a short table, then the robot profile and open warnings (for example "packing not verified").
- Share with `navigator.share({ files })` when available, else download.
- "Copy report" puts `report.md` on the clipboard for pasting into a chat.

## Screens

Seven screens sit behind a bottom tab bar, under a header strip with live link status and STOP that never leaves the screen.

**Header strip:** connection dot and robot id, median round-trip time, queue depth, "busy" badge, camera fps when the camera is on, sync state, session timer, STOP (red, 56 px).

1. **Connect:** Connect / Disconnect, robot name and profile, last session summary, "New session", quick checks (10 × `PING`, headlights white, all off).
2. **Monitor:** live tiles for the line sensors (two squares, black or white), round-trip sparkline, ultrasonic, accelerometer (x, y, z, magnitude), light, temperature and compass (when enabled). A poller panel picks queries and rates. A note field with quick tags.
3. **Console:** raw command input with history and favourites; a scrolling tx/rx log with timestamps, filters (tx, rx, errors, tests) and pause.
4. **Drive:** virtual joystick with arcade mixing to `MS,l,r`, speed cap slider, expo curve, trim (−20 to +20 % on one wheel), tilt mode using device orientation, dead-man, vibration on send failures and disconnects. Sends at `minWriteGapMs`. Optional live line-sensor overlay.
5. **Tests:** experiments grouped as Link, Sensors, Motion and Camera. Each opens a card with setup instructions, parameters, Run, live progress, result summary and run history; "Run again" repeats with the same parameters.
6. **Camera:** camera setup, track calibration, track map, marker calibration and live tracking (see Camera calibration and tracking).
7. **Data:** sessions list, export, copy report, storage use, delete; robot profiles; settings.

**Settings:** `minWriteGapMs`, `replyTimeoutMs`, `packWrites`, blocking table overrides, poller presets, mat size in cm, camera and resolution, marker colours, mock robot on or off.

## Test bench

Each test is a definition in `core/tests` with an id, title, setup text, parameters with defaults, a runner and a summary function. Results go into the log and into `report.md`.

Rules for every test: it shows its setup text and waits for Start; motion tests need the robot on the mat and end with `S`; link tests that spin motors ask for the wheels to be lifted; STOP aborts any test.

### Link (robot on a stand, wheels free)

| Id | Test | Procedure | Output |
| --- | --- | --- | --- |
| T1.1 | Ping baseline | 200 × `PING`; the next is sent when the reply arrives or times out | round-trip min, median, p95, max; loss |
| T1.2 | Poll rate sweep | `?LINE` sent without waiting, at 5, 10, 20, 30, 50 and 80 Hz for 5 s each | reply rate, round-trip and loss per rate; highest rate with p95 under 2× the T1.1 median |
| T1.3 | Write gap sweep | `MS,0,0` at gaps of 100, 50, 30, 20 and 10 ms, with `PING` every 250 ms | ping round-trip per gap; smallest safe gap |
| T1.4 | Packed writes | single writes of `PING#PING#`, `MS,0,0#PING#` and `?LINE#?TEMP#` | replies per write; packing safe yes or no |
| T1.5 | Blocking commands | send each command, then `PING` at once | PONG delay per command; becomes the blocking table |
| T1.6 | Buffer overflow | `DISP,HELLO WORLD`, then 10 × `PING` 20 ms apart | PONGs received out of 10 and the delay of each |
| T1.7 | Soak | `?LINE` at the T1.2 rate plus `MS,0,0` at the T1.3 gap for 3 min | round-trip drift, losses, disconnects |

T1.5 commands: `ICON,HAPPY`, `HORN`, `BEEP`, `TONE,440,500`, `DISP,A`, `DISP,HELLO`, `HL,255,255,255`, `UG,0,255,0`, `HO`, `CLS`, `?DIST`, `?LINE`, `?ACCEL`, `?LIGHT`, `?TEMP`. Add `?COMPASS` only when the profile marks it calibrated.

### Sensors (robot on the mat)

| Id | Test | Procedure | Output |
| --- | --- | --- | --- |
| T2.1 | Surface survey | pick a surface label, place the robot, 20 × `?LINE` | code histogram per surface; one summary table across labels |
| T2.2 | Lane crossing | drive across the lane at `MS,20,20`, black to black, polling `?LINE` at the safe rate | code sequence with times; transition widths in ms (in cm with tracking) |
| T2.3 | Ultrasonic | 20 × `?DIST` per labelled scene: open track, cone at 10 cm and 30 cm, bridge, hand | mean, spread, timeouts, reply delay |
| T2.4 | Accelerometer | still for 5 s; `F,100` start; spin `L,60`; a light bump | noise, peak g per event, sample rate achieved |
| T2.5 | Light and temperature | open track, under the bridge, headlights on and off | values per scene |
| T2.6 | Compass (guarded) | still at 4 headings 90° apart; motors on and off | heading per pose, noise, motor offset |

T2.1 surface labels: lane blue end, lane purple, lane pink end, white border, black background, checkered white, checkered black, start line, bridge deck, floor outside the mat, custom. Each sample set takes an optional note.

### Motion (robot on the mat; camera tracking when calibrated, otherwise manual entry)

| Id | Test | Procedure | Output |
| --- | --- | --- | --- |
| T3.1 | Deadband | `MS,v,v` from 0 up in steps of 5 every 0.8 s until it moves (camera or a "moving" tap); repeat backwards and per wheel | lowest moving value per wheel and direction |
| T3.2 | Straight speed | `F,s` for 1.5 s at s = 30, 50, 70, 100 | distance, speed in cm/s, sideways drift; trim suggestion |
| T3.3 | Start and stop | `F,100` from rest; `S` at full speed | time to 90 % speed; stopping distance |
| T3.4 | Spin rate | `L,s` and `R,s` for 1 s at s = 30, 50, 70, 100 | degrees per second per speed and side |
| T3.5 | Arcs | `MS,l,r` for 1.5 s over pairs such as 100/50, 100/0, 70/35, 50/25 | radius and speed per pair; effective track width |
| T3.6 | Battery check | T3.2 at s = 100, labelled with time and a battery note | speed over the day |

Manual entry: when tracking is off, the app asks after each run for distance or drift in cm, or angle in degrees, with a hint on how to measure it.

### Camera (phone on a tripod)

| Id | Test | Procedure | Output |
| --- | --- | --- | --- |
| T4.1 | Capabilities | dump `getCapabilities()` and settings for every camera | JSON per camera |
| T4.2 | Calibration check | tap 4 or more known points after calibration | reprojection error in cm |
| T4.3 | Tracking quality | robot still for 3 s at 5 spots: blue end, pink end, bridge, a hairpin, start | detection rate, position jitter in mm, false detections |
| T4.4 | Frame timing | 30 s of tracking | fps, processing time, frame gaps |
| T4.5 | LED latency | switch headlights between colours A and B at random 300–700 ms intervals, 30 times | send-to-seen latency (Bluetooth + firmware + camera) |
| T4.6 | Motion latency | `F,60` from rest, 10 times | send-to-first-motion latency |
| T4.7 | Tracked lap | drive one full lap manually with tracking on | trajectory, speed profile, lap time, line codes along the path |

## Camera calibration and tracking

The camera turns the mat into a coordinate system in centimetres and reports the robot's position and heading in it, from a phone fixed on a tripod at the mat's edge.

Coordinates: the user taps the mat corners in order top-left, top-right, bottom-right, bottom-left, as seen with the start/finish line at the top left. Origin at top-left, x to the right, y down, units cm.

### Camera setup

- After permission, `enumerateDevices()` lists every camera with its label. The user picks one; the choice is remembered.
- Request 1280 × 720 at 30 fps and log the settings actually granted.
- If `zoom` is in the capabilities, show a slider and default to its minimum for the widest view.
- Once the shot is framed, lock exposure, white balance and focus where supported (`exposureMode: 'manual'` with `exposureTime` or `exposureCompensation`, `whiteBalanceMode`, `focusMode`), so LED colours stay stable. Log what was applied.
- Use `requestVideoFrameCallback` for per-frame timestamps, falling back to requestAnimationFrame.

### Track calibration

1. Mount the phone, frame the whole mat, tap "Capture still".
2. Tap the four mat corners in order; a magnifier loupe helps place each one, and corners stay draggable.
3. Enter mat width and height in cm, measured with a tape.
4. Optional: tap up to 8 extra points with known mat coordinates for a least-squares fit.
5. Solve the homography with normalised DLT (exact for 4 points, least squares for more). Draw the reprojected mat outline over the live view; it must sit on the mat edges.
6. Save the calibration: id, camera id and settings, image size, points, mat size, H and its inverse, reprojection error, still image.

"Check" mode draws the outline live, so a bumped tripod is obvious; recalibrating takes under a minute.

### Track map

- Warp the still to a top-down image at `mmPerPx` (default 5) by inverse mapping with bilinear sampling. Export it as PNG.
- Classify each top-down pixel as `offtrack` (dark), `border` (bright, low saturation), `lane` (saturated, hue in the blue–pink range) or `other`. HSV thresholds have sliders with a live preview. Export a mask PNG and class percentages.
- Colour scan: a hue histogram of the mat, used to suggest marker colours that barely occur on the track.
- Landmarks: the user taps named points on the map (start/finish, bridge entry and exit, hairpin apexes, cones), saved with the calibration.

### Marker calibration

- Marker A and marker B are robot lights, each a light source (both headlights, left headlight, right headlight, underglow) plus a colour. Default: A = both headlights green `0,255,0`, B = underglow in the colour the colour scan suggests.
- The app sets the lights, then the user taps each marker in the live view. It samples a 9 × 9 patch, stores the HSV centre and tolerances, and shows sliders with a live mask overlay.
- Watch for false positives: red cones, white borders, and the yellow battery labels on top of the robot.

### Tracking, per frame

1. Draw the frame scaled to 640 px wide and read its pixels.
2. Threshold each marker colour inside a search window around its last position (whole frame when lost), with a minimum brightness.
3. Take the largest connected blob above `minAreaPx`; centroid in image pixels; confidence from area and compactness.
4. Map centroids through H to mat cm. Heading = direction from marker B to marker A. With one marker only, heading comes from velocity while moving.
5. Filter x, y and heading with an alpha-beta or constant-velocity Kalman filter. Log both raw and filtered pose.
6. Predict the pose forward by a configurable latency (default from T4.5) and show measured and predicted dots.

Overlays: the live view with blobs and the mat outline, and a top-down mini-map with a trail coloured by speed.

Known errors to record, not fix: headlights sit above the mat, so an oblique camera shifts them slightly (parallax); the bridge hides the robot briefly.

Targets: at least 20 fps at 640 px on the user's Android phone, at most 20 ms processing per frame. If missed, move the tracker into a Web Worker with ImageBitmap transfer.

Portability: vision functions take `{ width, height, data }` buffers and return plain objects, so a React Native frame processor can call them later.

## Robot profiles, mock robot and automated tests

Measured values live in a per-robot profile, and a simulated robot lets the whole app run and be tested without hardware.

### Robot profile

Keyed by robot id (for example `popuv`), stored in IndexedDB and exported with every session. Test summaries offer "Save to profile" for the values they measure.

```ts
type RobotProfile = {
  robotId: string; name: string; mac?: string;
  trim: number;                                   // -0.2..0.2, applied to the right wheel
  deadband?: { lf: number; lb: number; rf: number; rb: number };
  speedTable?: { cmd: number; cmPerS: number }[];
  spinTable?: { cmd: number; degPerS: number }[];
  trackWidthCm?: number;
  blocking?: Record<string, number>;              // ms, from T1.5
  safeWriteGapMs?: number; safePollHz?: number;
  compassCalibrated: boolean;
  notes: string; updatedAt: string;
};
```

### Mock robot (`MockTransport`)

It emulates `microbitapi.js` closely enough to develop and test every screen:

- Parses commands the same way: `#` delimiter, split on `,`, 20-byte writes.
- Runs one handler at a time with the blocking times from the table, and drops bytes when its small receive buffer is full.
- Configurable link latency, jitter and loss.
- A 2D world: differential-drive kinematics, line sensors that read a mask image (the exported track mask when available), a fixed or scripted ultrasonic value.
- `?COMPASS` answers only when "calibrated" is set; otherwise it blocks, like the real robot.

A Settings toggle swaps in the mock, and the header shows "MOCK" in orange.

### Automated tests (Vitest)

Required before a milestone counts as done:

- Protocol: every command builder; parsing every reply type, partial chunks, and two replies in one chunk.
- Scheduler: priorities, latest-wins coalescing, safety jump, minimum gap, blocking hold, 20-byte limit.
- Matcher: first-in-first-out matching, timeouts, round-trip maths.
- Vision: homography on synthetic points (error under 0.1 px), rectify round trip, blob detection on a synthetic frame.
- Report: snapshot of `report.md` from a fixture session.
- End to end: T1.1 and T1.5 against the mock.

## Milestones

Build in this order. Each milestone is usable at the track on its own, so measuring starts long before the app is finished.

1. **M0 — Connect and log** (target 45 min)
   - Vite + React + TypeScript scaffold in `rally-lab/`, PWA manifest, dev loop with `adb reverse`, GitHub Pages workflow.
   - WebBluetoothTransport, scheduler with `safety`, `raw` and `query` channels, reply parser, logger with IndexedDB and dev sync, Console screen, header strip with STOP.
   - Done when the phone connects to a real robot, `PING` shows a round-trip time, and every tx and rx line appears in `logs/<sessionId>.jsonl` on the laptop.
2. **M1 — Monitor and link tests** (target +1.5 h)
   - Full scheduler, pollers, Monitor screen, test framework, T1.1–T1.6, T2.1, zip export with `report.md`, MockTransport.
   - Done when T1.1, T1.5 and T2.1 run on a real robot and the exported report holds their summaries.
3. **M2 — Drive and motion tests** (target +1.5 h)
   - Drive screen, robot profiles, T2.2–T2.5, T3.1–T3.6 with manual entry.
   - Done when a manual lap is driven from the app and the profile holds trim, deadband and the speed table.
4. **M3 — Camera** (target +3 h)
   - Camera setup, calibration, track map and mask, colour scan, marker calibration, tracking, T4.1–T4.7, and camera-measured results for T3.
   - Done when a tracked manual lap exports a trajectory with lap time and the reprojection error is under 2 cm.
5. **M4 — Polish** (as time allows)
   - T1.7, T2.6, landmarks, speed-coloured trail, tracking in a Web Worker, storage meter.

After each milestone the agent runs the unit tests, builds, deploys to GitHub Pages and adds an entry to `rally-lab/CHANGELOG.md`.

## Open questions

- [ ] Is a web app in Chrome on Android accepted as the race app? (Organizers.)
- [ ] May a phone on a tripod stand by the track during the timed run? (Organizers.)
- [ ] Mat size in cm, and whether the cones, ramps and bridge stay for the final.
- [ ] Does the lane read white or black to the IR sensors along its whole length? (T2.1)
- [ ] Is the robot in the final the one tested, and are fresh batteries allowed?
- [ ] Does Chrome on this phone expose the ultra-wide camera, and can exposure be locked? (T4.1)

Blocking times and receive-buffer behaviour come from reading the firmware source; T1.5 and T1.6 confirm or correct them.

## Appendix: command reference

| Command | Effect | Blocks |
| --- | --- | --- |
| `F[,s]`, `B[,s]` | forward or back, s 1–100, default 50 | no |
| `L[,s]`, `R[,s]` | spin in place | no |
| `S` | stop both motors | no |
| `ML,v`, `MR,v` | one wheel, −100 to 100; the other keeps its value | no |
| `MS,l,r` | both wheels, −100 to 100 | no |
| `HL,r,g,b`, `HLL,…`, `HLR,…` | headlights both, left, right; 0–255 | no |
| `UG,r,g,b`, `UGL,…`, `UGR,…` | underglow both, left, right | no |
| `HO`, `UGO` | all lights off; underglow off | no |
| `HORN`, `BEEP` | 440 Hz for 200 ms; 880 Hz for 100 ms | yes |
| `TONE,f,ms` | tone at f Hz for ms | yes, ms |
| `QUIET`, `MUTE` | stop sound | no |
| `DISP,text` | scroll text | yes, seconds |
| `ICON,name` | HAPPY, SAD, HEART, YES, NO, SKULL | yes, about 600 ms |
| `CLS` | clear the display | no |
| `?DIST`, `?LINE`, `?ACCEL`, `?LIGHT`, `?TEMP` | query; reply `TYPE:value#\n` | short |
| `?COMPASS` | heading 0–359 | starts calibration if uncalibrated |
| `PING` | reply `PONG#\n` | no |

UUIDs: service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`; RX (phone writes) `6e400003-b5a3-f393-e0a9-e50e24dcca9e`; TX (robot indicates) `6e400002-b5a3-f393-e0a9-e50e24dcca9e`. Line codes: 0 both white, 1 right black, 2 left black, 3 both black.
