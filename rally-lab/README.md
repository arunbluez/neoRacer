# Rally Lab

A measurement PWA for the Cutebot (micro:bit V2) over Web Bluetooth, for Chrome on Android.
It connects to a robot, runs repeatable experiments, tracks the robot with the phone camera,
and logs every packet and measurement so the race app can be built from measured facts.

It is a lab instrument, not the race app. See the PRD for the full brief.

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
4. Debug from the laptop at `chrome://inspect`.

While the dev server answers, the app posts its log once per second. The header shows the sync
state (green syncing, grey no dev server, red failing). Files land in `rally-lab/logs/`
(git-ignored):

- `logs/<sessionId>.jsonl` — every event, one JSON object per line
- `logs/<sessionId>/session-header.json`, `logs/<sessionId>/tests/<runId>.json`, calibration JSON
  and images

### At the track, untethered

The `Rally Lab` GitHub Actions workflow runs lint, tests and the build on every push to `main`
(and on pull requests), then deploys `main` to GitHub Pages:
`https://<owner>.github.io/<repo>/`. To deploy another branch, run the workflow by hand
(Actions → Rally Lab → Run workflow).

One-time setup: Settings → Pages → Source: **GitHub Actions**. If you deploy from a branch other
than `main`, also allow that branch in Settings → Environments → github-pages.

Logs stay in IndexedDB on the phone; export them from the Data tab later. When a new version is
deployed, the header shows **Reload new version**.

### Without a robot

Data → Settings → **Mock robot**. The mock emulates `microbitapi.js`: the same parsing, one
handler at a time with the firmware's blocking times, a 20-byte receive buffer that drops bytes,
link latency, jitter and loss, and a 2D world with differential-drive motion and line sensors
that read a synthetic track. The header shows **MOCK** in orange.

## Commands

| | |
| --- | --- |
| `npm run dev` | dev server with `/__log` and `/__artifact` |
| `npm test` | Vitest unit and end-to-end tests (mock robot) |
| `npm run lint` | ESLint; blocks DOM, browser globals and React inside `src/core` |
| `npm run typecheck` | `tsc -b`; `src/core` is checked against plain ES2022 (no DOM) |
| `npm run build` | type-check and production build with service worker |
| `npm run icons` | regenerate the PNG icons |

## Layout

```
src/core/       portable TypeScript: no DOM, no React (moves to React Native unchanged)
  protocol/     command builders, ASCII codec, reply parser (port of ReactNativeApi.ts)
  link/         write scheduler, reply matcher, blocking table, link stats, poller, RobotLink
  log/          event types, session ids, logger, report and export
  tests/        experiment definitions, runner
  vision/       homography, rectify, colour classify, blob tracker, pose filter
  model/        robot profile, motion model fits, drive mixing
  sim/          mock robot: firmware emulation, 2D world, synthetic track
  lab.ts        composition root used by the UI
src/adapters/   platform code: Web Bluetooth, mock transport, Dexie, dev sync, camera, device
src/ui/         React screens and components
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
- After a blocking command (`ICON` 600 ms, `HORN` 200, `BEEP` 100, `TONE` its duration, `DISP`
  (chars × 6 + 5) × 150) every channel but `safety` is held for that time plus 20 ms. T1.5 results
  in the robot profile override the table.
- Replies carry no ids: they are matched first in, first out per type. Round-trip time is reply
  time minus write-resolved time; queries without a reply after `replyTimeoutMs` (500) count as
  lost.
- On an unexpected disconnect the link reconnects to the same device with backoff 0.25, 0.5, 1,
  2 s, at most 10 tries.
