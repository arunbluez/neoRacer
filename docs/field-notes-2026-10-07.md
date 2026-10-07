# Field notes: robot `puguz`, 7 Oct 2026

Measured with Rally Lab (build `fde9a77`) on the real track, Android phone with Chrome 154. Two
sessions: `20261007-132438-puguz` (link, sensors, deadband) and `20261007-135358-puguz`
(straight speed, spin, manual driving). These are the facts the race app should be built on.

## Bluetooth link

| | |
| --- | --- |
| Connect | 7.0 s from tapping Connect to ready |
| Round trip (200 × PING) | median 23.5 ms, p95 35.9 ms, max 40.9 ms, 0 lost |
| Polling | fine up to **30 queries/s** (p95 44 ms); at 50/s replies cap at ~35/s and queue up (RTT ~490 ms) |
| Writes | **100 writes/s** (10 ms apart) with no loss and no effect on ping times |
| Packed writes | safe: `PING#PING#`, `MS,0,0#PING#`, `?LINE#?TEMP#` all fully answered |
| Reconnect after a drop | 16.7 s (one try) |

So replies, not writes, are the bottleneck: budget **≤ 30 queries per second in total** and send
motor commands as often as needed.

## Commands that block the robot

| Command | Robot busy for |
| --- | --- |
| `ICON,HAPPY` | 582 ms |
| `HORN` | 204 ms |
| `BEEP` | 105 ms |
| `TONE,440,500` | **the robot dropped the Bluetooth link** ~4 s later (supervision timeout); reconnect took 16.7 s |

While the robot is busy, later commands wait in its receive buffer: during an 11 s `DISP,HELLO WORLD`
all 10 PINGs sent 20 ms apart were answered after the scroll, none lost. That also means **motor
commands sent during a blocking command are not executed until it ends**, so the robot keeps its
last speed. In the race: no `DISP`, `ICON`, long `TONE`; use `HORN`/`BEEP`/lights only when stopped
or on a straight where 0.1–0.2 s of no control is acceptable. Lights (`HL`, `UG`, `HO`) don't block.

## Line sensors (`?LINE`, 20 samples per surface, 100 % consistent)

| Surface | Code |
| --- | --- |
| Lane blue, purple, pink | 0 (both white) |
| White border | 0 |
| Checkered white | 0 |
| Black background | 3 (both black) |
| Checkered black | 3 |
| Floor outside the mat | 3 |

The infrared sensors see the **lane and its borders as one white band** (~22 cm wide: 18 cm lane +
2 × 2 cm borders) on black. They cannot tell the lane from the border, only "on the band" from
"off it". A race controller has to steer along the band's edge (or stay on the band and react to
black), and the checkered start/finish black squares read like leaving the track.

## Other sensors

- **Ultrasonic** (`?DIST`): open track 76 cm; a cone at 10 cm reads 9 cm; **a cone at 30 cm is not
  seen** (reads the background, 77 cm); a hand gave 11 × no echo then 561 cm (garbage). Reply takes
  ~32 ms, 63 ms with no echo. Only useful for something very close.
- **Accelerometer** (`?ACCEL`): still noise ~4.4 mg per axis, |g| ≈ 1045 mg; ~27 Hz when polled
  back to back; `F,100` from rest peaks at 1.3–2.2 g, a spin ~1 g, a bump ~0.6 g.
- **Light**: read 0 every time. **Temperature**: 23 °C.

## Motion

- **Deadband** (lowest moving command, manual taps in steps of 5, may be one step high): both wheels
  forward 15, back 15; left wheel forward 20, back 15; right wheel forward 20, back 20.
- **Straight** (`F,s` for 1.5 s, tape measure, includes start-up and coasting):

  | s | distance | speed | sideways drift |
  | --- | --- | --- | --- |
  | 30 | 50 cm | 33 cm/s | 16 cm **left** |
  | 50 | 85 cm | 57 cm/s | 32 cm **left** |

  Speed is roughly 1.1 cm/s per command unit (so `F,100` ≈ 1.1 m/s, extrapolated), and the robot
  can't go slower than ~20 cm/s because of the deadband. The right wheel is faster: trim **−11.5 %
  at 30 and −8 % at 50** on the right wheel (with a 9 cm track width).
- **Spin** (`L,30` / `R,30` for 1 s): about 1.3 turns left and 1.2 turns right (≈ 470 and 430 °/s;
  entered as turns into a degree field, so the profile's spin table of 1.3 °/s is wrong; rerun
  T3.4). That implies an effective track width of ~8.5 cm.

## Manual driving

The stick felt too sensitive and erratic because commands below the deadband (15–20) don't move a
wheel: with speed cap 35 and expo 0.6, half the stick produced commands of 6–14, so the robot did
nothing and then lurched, and in gentle turns one wheel stopped while the other ran. Rally Lab now
maps the stick onto [deadband, cap] per wheel, has a turn-sensitivity slider, and applies the trim
per speed. On 91 % of line samples while driving the robot was on the white band.

## Camera

- Chrome exposes only `camera 0, facing back` and `camera 1, facing front`: **the ultra-wide lens
  is not available to web apps on this phone**.
- Held in portrait the stream was 720 × 1280 ("crop-and-scale"): a narrow vertical strip of the
  sensor, which is why the mat didn't fit. Use landscape and 4:3 (now the default).
- Exposure lock works; white-balance and focus lock failed because the phone reports 0 for both in
  auto mode (fixed: the lock now retries with values inside the allowed range).

## Still to measure

Bridge deck and start line surfaces (T2.1); straight speed at 70 and 100; track width (T3.5);
spin rate in turns (T3.4); trim check (T3.7); everything on the camera side (calibration, T4.x).
