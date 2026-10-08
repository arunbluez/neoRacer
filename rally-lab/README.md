# Rally Lab

A measurement PWA for the Cutebot (micro:bit V2) over Web Bluetooth, for Chrome on Android.
It connects to a robot, runs repeatable experiments, tracks the robot with the phone camera,
and logs every packet and measurement so the race app can be built from measured facts.

It started as a lab instrument; it now also drives the track by itself: **Auto** runs the
measured route with the phone camera, held by hand, correcting the robot as it goes.

The tab bar shows **Connect, Drive, Auto, Data**. The lab tools (Monitor, Console, Tests and
the tripod Camera) are behind Data → Settings → **Lab tools**.

## Auto run (camera assisted)

The robot drives a hard-coded route (the [track code](../docs/track.md)). The phone camera finds
the **track by its coloured lane** in every frame (so the phone can be held by hand, people and
bags around the mat don't matter, and the mat's black edges don't need to be in view), finds
**your robot by its lights** (all four set to one colour, blinked to tell it from other robots),
and the app corrects the robot when it drifts from the route. The line sensors are a last guard:
both black (off the lane) stops the run.

1. Connect the robot. Stand at a **long side** of the mat (the bridge side or the start side: the
   3 m length then runs across the picture and you can stand close), hold the phone **in
   landscape** and high, with the whole lane loop in the picture.
2. Auto → **Start camera**. The badges show `track ✓` (with how well the lane fits) and which side
   you are on. The coloured route line must sit on the lane all the way round; if not, **Re-detect
   track**.
3. Place the robot on the start line, facing section a (towards side b). **Find my robot** blinks
   its lights and finds the light that blinked (a green circle marks it); Start does this by
   itself when needed. Lights: green by default, cyan or yellow if green clashes with someone else.
4. Pick the speed (start at the slowest, 22 cm/s; turns follow the lane's curves, or pick
   **Spin on the spot**), tap **Full screen**, then **Start**. STOP (or the header's STOP, or
   leaving the app) stops it.
5. After the run: the summary shows the time and how far off the route each section was. Then
   make the next lap faster with **Lap tuning** (below), or export the logs (**Export logs**) and
   send them over: the route and the tuning get corrected from them.

A run doesn't end at the first problem; it **recovers** and carries on:

- **Off the lane** (both line sensors black), **stuck** (the camera sees it not moving while it's
  driven) or **off the path** (the camera sees it 18 cm off): it stops, backs straight up until the
  sensors see the lane again, gives the camera a moment, picks the route up where it is, turns on
  the spot to face along it if needed, and drives on. After 20 recoveries, or 3 at the same spot, it
  stops.
- **Camera lost the robot** (outside the bridge) for a second: it holds still and the camera looks
  along the route back to where it last saw it (an orange strip on the picture). Not there after
  3 s: it blinks the lights and finds the robot wherever it is. It gives up after 30 s.
- The line sensors also correct the position: a sensor reading black is at the lane band's edge,
  11 cm from the painted centre line, a sideways fix exact to a centimetre where the camera is least
  sure (the far end of the mat).
- While driving, motor commands and line queries go out packed into one Bluetooth write.

A robot without motor numbers (no Deadband test yet) gets a note on the Auto screen: robots differ a
lot (zopip's right wheel barely turned at the command that drives the left at 20 cm/s), and the
default numbers make it pull hard to one side. Run **Deadband** (T3.1) and **Straight check** (T3.7)
once per robot; in the simulator that took a robot like zopip from 5 recoveries a lap to none.

The **Cone dodges** card moves the route sideways around the cones on c (they get moved from day to
day): watch the route line on the live picture and slide it clear of them. The robot is ~10 cm wide.

What the app does each frame: marks the lane-coloured pixels (blue → purple → pink), and fits the
known lane to their edges (a robust homography fit that only matches an edge with the lane on the
correct side); while tracking it starts from the last frame's fit, otherwise from the lane band's
outline, the mat's outline and a few restarts. From the fit it works out where the phone is, finds
the robot's lights near where the robot should be, and corrects them for their height above the
mat (seen from 1.1 m, a light 3 cm up appears up to 11 cm too far away at the far end). An
estimator (Kalman filter) combines the camera fixes, which arrive ~100 ms late, with what the wheel
commands should do, and learns how the robot pulls to one side, how fast it really goes and how far
it really turns. The follower steers by curvature along the route, keeping every moving wheel above
its deadband.

Logged for every run: `auto.start` (route, settings, motor model, plan), `auto.tick` (25 per
second: estimated pose, section, error, wheel commands, learned bias), `auto.fix` (every camera
fix and whether it was used), `auto.cam` (once per second: fps, track fit score, robot found, the
search circle, phone position), `auto.line`, `auto.spin`, `auto.end` (summary) and the blink test's
result (`app` event `auto.blink`). `report.md` gets an "Auto runs" section, and each run saves the
camera frame and a 1 cm/px top-down picture of the mat at its start and end into the session's
images.

## Lap tuning and the race engineer

Instead of one speed for the whole lap, a **lap tuning** sets each section's speed on its
straights and in its turns, how fast the speed may rise (acceleration) and fall (braking, so the
robot slows down before a turn in time), and a grip limit for turns. A speed profile
(`race/speedProfile.ts`) turns it into a target speed at every point of the route, the way
lap-time simulators do (a forward pass for acceleration, a backward one for braking), keeping
the physical limits: nothing below the deadband speed, tight turns fast enough for the inner wheel
to keep turning (~35 cm/s in the 13 cm hairpins). It also predicts the lap time (in the simulator
within ~1 %).

The Auto screen's **Lap tuning** card shows the tuning in use, the predicted time per section and
the runs of this session (time, prediction, worst distance off the path, line sensor events).
After a lap there are two ways to the next tuning; either way the changes are shown first and
apply only on **Apply**, **Undo** goes back one step, and no number can rise by more than 25 % in
one step (lowering is always allowed):

- **Quick tune**: rules, on the phone, offline (`race/learner.ts`). Parts of sections the robot
  drove cleanly (within 4 cm, no line events) get faster (straights ×1.15, turns ×1.08); parts
  where it wandered stay; where it went past 7.5 cm or a line sensor fired they get slower, and
  where it left the lane clearly slower, with earlier braking.
- **The race engineer**: Claude reads the runs and sets the next tuning, with reasons and what to
  watch on the next lap. On a laptop with Claude Code signed in (your subscription), **Send runs to
  the engineer** (the session zip, via the share sheet), then `npm run engineer -- <the zip>` in
  [`engineer/`](engineer/README.md); it writes `engineer-plan-….json`. Get that to the phone
  (AirDrop, Nearby Share, a message) and **Load plan**, or paste its text with **Paste plan**.
  Without a laptop: **Copy brief for the Claude app**, paste it into the Claude app, and paste its
  answer back with **Paste plan**.

Claude never drives: it runs between laps, on the logs. Its plan goes through the same checks as
a quick tune (limits, 25 % step), and track code edits it suggests (straight lengths, turn radii,
at most 15 % or 15 cm) apply only if ticked. For the final's single timed attempt, **Keep for the
race** saves the tuning with its best clean lap, and **Use race tuning** brings it back.

Every run logs the tuning it drove and its prediction (`auto.start`), and the summary has line
events per section, so the analysis (`race/lapAnalysis.ts`) can split every section into its
straights and its turns.

## Run it

```bash
cd rally-lab
npm install
npm run dev            # http://localhost:5173
```

### On the phone, tethered (logs stream into the repo)

1. Enable USB debugging on the phone and plug it in.
2. `adb reverse tcp:5173 tcp:5173`
3. Open `http://localhost:5173` in Chrome on the phone. Chrome treats localhost as secure, so
   Bluetooth, camera and orientation work without HTTPS.
4. Debug from the laptop at `chrome://inspect` (`window.__lab` and `window.__cc` are the lab and
   camera controller in dev builds).

While the dev server answers, the app posts its log once per second. The header shows the sync
state (green syncing, grey no dev server, red failing). Files land in `rally-lab/logs/`
(git-ignored):

- `logs/<sessionId>.jsonl`: every event, one JSON object per line
- `logs/<sessionId>/session-header.json`, `tests/<runId>.json` (+ per-run files such as
  `trajectory.json`), `calibration/<id>.json` with the still, map and mask images

### At the track, untethered

The `Rally Lab` GitHub Actions workflow runs lint, tests and the build on pushes to `main` and on
pull requests, then deploys `main` to GitHub Pages: `https://<owner>.github.io/<repo>/`. To deploy
another branch, run the workflow by hand (Actions → Rally Lab → Run workflow).

One-time setup: Settings → Pages → Source: **GitHub Actions**. To deploy from a branch other than
`main`, also allow that branch in Settings → Environments → github-pages.

Logs stay in IndexedDB on the phone; export them from the Data tab. When a new version is
deployed, the header shows **Reload new version**.

### Without a robot

Data → Settings → **Mock robot**. The mock emulates `microbitapi.js`: same parsing, one handler at
a time with the firmware's blocking times, a 20-byte receive buffer that drops bytes, a queue of
at most 10 pending commands, link latency, jitter and loss, and a 2D world with differential
drive behaving like the robot measured at the venue (deadband 18, ~20 cm/s at the deadband, right
wheel 10 % fast, 8.5 cm track width) and line sensors on a copy of the real mat. The **simulated
camera** is a hand-held phone behind the near end of the mat (it sways a little), with the robot's
lights drawn at their real heights, so Auto runs end to end in the browser; the tripod Camera tab
and the T4 tests use it too. The header shows **MOCK** in orange.

## A day at the track

Each test runs in under a minute and repeats with **Run again**. Results you want to keep go into
the robot profile with **Save to profile**; everything is in the log either way.

1. **Connect** (Connect tab). The header shows the robot id and the median round trip.
2. **Link, robot on a stand**: T1.1 ping baseline → T1.5 blocking commands (save: replaces the
   firmware estimates in the scheduler) → T1.2 poll rate (save) → T1.3 write gap (save) → T1.4
   packed writes (save) → T1.6 buffer overflow. Optional: T1.7 soak (3 min).
3. **Sensors, robot on the mat**: T2.1 for every surface label (lane blue end, purple, pink end,
   white border, black background, checkered, start line, bridge deck, floor). The cross-label
   table answers "does the lane read white or black to the IR sensors?". Then T2.3–T2.5.
4. **Motion**: T3.1 deadband → T3.2 straight speed (saves the speed table and a trim per speed) →
   **T3.7 straight check** until it drifts less than ~2 cm (it drives exactly like the Drive tab and
   corrects the trim) → T3.4 spin rate (enter turns) → T3.5 arcs (track width, needs T3.2) → T3.6 a
   few times over the day. Without the camera they ask for tape-measure values.
5. **Camera, phone fixed at the mat's edge, in landscape** (a tripod, or taped to the back of a deck
   chair or a stack of boxes; it only has to stay still; a bumped phone recalibrates in under a
   minute): Camera → Setup (pick the widest camera, frame shape 4:3, lock exposure) → Calibrate (capture still, tap the 4 mat corners, enter the taped mat size, save) →
   Map (check the class mask, tap landmarks: at least **start/finish**) → Markers (Light up A and
   B, tap A on the headlights, B on the underglow) → Track. Then T4.2 calibration check (max error
   under 2 cm), T4.3 tracking quality, T4.4 frame timing, T4.5 LED latency (apply it to settings),
   T4.6 motion latency, and **T4.7 tracked lap** (drive on the Drive tab, Finish in the banner).
   Rerun T3.x with tracking on for camera-measured motion.
6. **Export**: Data → Export this session (share sheet or download), or **Copy report** to paste
   `report.md` into a chat with a coding agent.

Avoid `TONE` longer than ~200 ms and `DISP`/`ICON` while driving: a 500 ms tone dropped the
Bluetooth link on a real robot, and blocking commands freeze motor updates (see
[field notes](../docs/field-notes-2026-10-07.md)).

## What the real mat looks like to the camera

The layout, sections and measurements are in [docs/track.md](../docs/track.md) (mat 200 × 300 cm,
seen from side b). Under hall lighting the black background reads V ≈ 0.25–0.42, the lane runs blue
(223°) → pastel purple (295°, S ≈ 0.28) → pink (335°), and **hues 80–210° never occur on the mat**:
green and cyan make the best markers (the defaults). 1 cm/px pictures of the mat are test
fixtures (`src/core/vision/fixtures/`): they keep the class thresholds honest and check that the
route runs on the lane.

## Commands

| | |
| --- | --- |
| `npm run dev` | dev server with `/__log` and `/__artifact` |
| `npm test` | Vitest: unit tests and end-to-end runs against the mock robot |
| `npm run lint` | ESLint; blocks DOM, browser globals and React inside `src/core` |
| `npm run typecheck` | `tsc -b`; `src/core` is checked against plain ES2022 (no DOM) |
| `npm run verify` | lint + typecheck + tests (what CI runs before the build) |
| `npm run build` | production build with service worker |
| `npm run icons` | regenerate the PNG icons |

## Layout

```
src/core/       portable TypeScript: no DOM, no React (moves to React Native unchanged)
  protocol/     command builders, ASCII codec, reply parser (port of ReactNativeApi.ts)
  link/         write scheduler, reply matcher, blocking table, link stats, poller, RobotLink
  log/          event types, sessions, logger, report.md and session.zip
  tests/        experiment definitions (T1–T4), runner, helpers
  vision/       homography, rectify, colour classes, blobs, pose filter, tracker, pipeline
  model/        robot profile, drive mixing, motion fits
  sim/          mock robot: firmware emulation, 2D world, synthetic copy of the mat
  lab.ts        composition root used by the UI
src/adapters/   platform code: Web Bluetooth, mock transport, Dexie, dev sync, cameras
                (getUserMedia, simulated, tracking worker), device, share/download
src/ui/         React screens and components
engineer/       the race engineer on a laptop: session zip → analysis → Claude (Agent SDK) → plan
vite-plugins/   dev-only /__log and /__artifact endpoints
```

Only `src/adapters` touches browser APIs. Porting to React Native means rewriting the adapters and
the UI and keeping `src/core` as is.

## How the link works

- One transport, one write scheduler, one reply matcher; every byte is logged.
- The scheduler keeps exactly one GATT write in flight, spaces writes by `minWriteGapMs`
  (default 30), and rejects writes over 20 bytes. Channels, highest priority first:
  `safety` (S; clears motor, jumps the queue), `motor` (latest wins; ML/MR are folded into one
  MS so no wheel update is lost), `query` (unsent duplicates dropped), `light` (one slot per
  light command; HL supersedes HLL/HLR, HO supersedes all), `oneshot` (FIFO), `raw` (FIFO).
- After a blocking command every channel but `safety` is held for its block time plus 20 ms.
- Replies carry no ids: they are matched first in, first out per type. Round-trip time is reply
  time minus write-resolved time; queries without a reply after `replyTimeoutMs` (500) are lost.
- On an unexpected disconnect the link reconnects to the same device with backoff 0.25, 0.5, 1,
  2 s, at most 10 tries. A page reload needs a tap on Connect.
- STOP (every screen) sends S through `safety` and aborts any test; a stopped test can send
  nothing else. Hiding the page sends S and stops tests and pollers. Manual drive uses a dead-man.

## Log and export format

`events.jsonl` holds one event per line: `{ "t": <ms since session start>, "k": <kind>, ... }`.

| Kind | Fields |
| --- | --- |
| `ble.tx` | cmd, ch, bytes, tEnq, tSent, tDone (+ packId, mergedFrom, blockMs, err) |
| `ble.drop` | cmd, ch, status (coalesced / cleared / rejected) |
| `ble.rx` | raw |
| `ble.state` | state, reason, durMs, name, id, writeMode |
| `ble.err` | op, message |
| `sensor` | type, value, rttMs |
| `link.stats` | rttMed, rttP95, txps, rxps, lost, errors, queue, busy |
| `input` | mode, left, right, raw |
| `cam.stats` | fps, procMs, procP95, grabMs, dropped, detectRate |
| `cam.pose` | xCm, yCm, headingDeg (filtered), conf, tFrame, procMs, raw {xCm, yCm, headingDeg} |
| `test.start` / `test.sample` / `test.end` | testId, runId, params, data, summary |
| `note` | text, tags |
| `app` | event, detail (session header, settings, profile, camera, errors, visibility, …) |

`session.zip` holds `session.json` (header, robot profile, calibrations, test runs with data and
summaries), `events.jsonl`, `report.md` (written for a coding agent: per-test sections, profile,
calibrations, open warnings) and `images/` (calibration still, rectified map, track mask).

## Known limits worth measuring, not fixing

- Camera poses are the position of marker A (the headlights, ~5 cm ahead of the axle). Heading
  from B → A uses a ~5 cm baseline, so it is noisy at ~1 px/cm; when moving, the filtered heading
  from velocity is steadier.
- At 640 px processing width the far side of the mat is ~0.9 px/cm and the near side ~1.8 px/cm,
  so LED blobs are a few pixels. Raise `procWidth` (Data → Settings) if T4.3 shows misses far away.
- LEDs sit above the mat, so an oblique camera shifts them slightly (parallax); the bridge hides
  the robot for a moment.
- Pixel grab (draw + read back) usually costs more than tracking; T4.4 reports both. If they
  exceed ~15 ms, turn on **Track in a Web Worker**.
