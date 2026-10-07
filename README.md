# neoRacer

Tools for the [Next App Robot Rally 2026](docs/contest.md): driving an Elecfreaks Cutebot
(BBC micro:bit V2) around the floor-printed track from a phone over Bluetooth.

| Folder | What |
| --- | --- |
| [`rally-lab/`](rally-lab/) | **Rally Lab**, a measurement PWA for Chrome on Android: connects to a robot, runs repeatable link, sensor, motion and camera experiments, tracks the robot with the phone camera, and logs everything for building the race app. See its [README](rally-lab/README.md). |
| [`docs/`](docs/) | [Rally Lab PRD](docs/rally-lab-prd.md) and the [contest rules](docs/contest.md). |
| [`reference/`](reference/) | The robot firmware source [`microbitapi.js`](reference/microbitapi.js) (the source of truth for robot behaviour) and the original [`ReactNativeApi.ts`](reference/ReactNativeApi.ts) driver, copied from [droidconHQ/CuteBotDriver](https://github.com/droidconHQ/CuteBotDriver). The robots at the event come flashed with this firmware. |

## Quick start

```bash
cd rally-lab
npm install
npm run dev        # then: adb reverse tcp:5173 tcp:5173, open http://localhost:5173 on the phone
```

No robot at hand? Turn on **Mock robot** in Data → Settings: a simulated Cutebot on a copy of
the real mat, with a simulated camera.

Pushes to `main` run lint, tests and the build, and deploy Rally Lab to GitHub Pages
(one-time setup: Settings → Pages → Source: **GitHub Actions**).
