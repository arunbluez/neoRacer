# Race engineer

Reads the auto runs from a Rally Lab session export, and asks Claude for the next lap's tuning:
per-section speeds, acceleration, braking, grip and steering, with the reasons and what to watch
on the next lap. Claude never drives the robot; it works between laps, on the logs.

## Set up (once, on a laptop)

1. Node 18 or newer.
2. Claude Code, signed in with your Claude account: install it
   ([claude.com/claude-code](https://claude.com/claude-code)), run `claude` and `/login`. The
   engineer runs Claude through the Claude Agent SDK, which uses that login, so the rounds count
   against your subscription. (If `ANTHROPIC_API_KEY` is set in the shell, the SDK uses that key
   instead and bills the API; the command prints which one it used.) Use your own login for
   your own runs.
3. In this folder: `npm install` (the SDK brings its own Claude Code binary, ~250 MB).

## Each round at the track

1. On the phone, after a lap: Auto → Lap tuning → **Send runs to the engineer** (shares the
   session zip: AirDrop, Nearby Share, Drive, a message to yourself…).
2. On the laptop:

   ```bash
   npm run engineer -- ~/Downloads/20261008-101500-puguz.zip
   ```

   It prints the runs it read, Claude's answer (about 20 s with Haiku 5.5), the changes number by
   number, and writes `engineer-plan-<run>.json` next to the zip.
3. Get the plan file back to the phone and **Load plan** (or open it, copy the text, and
   **Paste plan**). Check the changes, then **Apply**. Undo is one tap.

`npm run engineer -- --watch ~/Downloads` waits for new zips in a folder and answers each one, so
the round is: share the zip, wait for the plan, send it back.

## Options

| Option | |
| --- | --- |
| `--runs N` | read the latest N runs (default 4) |
| `--model ID` | Claude model (default `claude-haiku-5-5`, fast; `claude-sonnet-5-5` or `claude-opus-5-5` for a deeper look) |
| `--effort low\|medium\|high` | how hard it thinks (default medium) |
| `--offline` | no Claude: the app's quick tune, as a plan file |
| `--dry-run` | print what Claude would be told and stop |
| `--out DIR` | write the plan there |

Input: a session zip (one session, or Data → Export all), an `events.jsonl`, or a folder (its
newest zip).

## What Claude gets

- Standing instructions (`src/core/race/engineerBrief.ts`, `engineerSystem`): the goal (fastest
  tuning that finishes reliably, the final being one timed attempt), how the robot drives, the
  physics it can't tune away (deadband speed, the hairpins' minimum speed, the bridge hiding the
  robot), the knobs and their limits, and how to work (fix failures first, raise clean long
  straights first, brake earlier rather than slow a turn that ran wide, route edits only for
  repeated geometric errors).
- The data: the route, the tuning in use and its predicted time per section, prediction vs
  actual so far, the runs section by section (straights and turns apart), and the quick tune's
  suggestion as a baseline.
- Two tools and nothing else (no files, shell or web): `predict_lap` (the lap time a candidate
  tuning would give, and what the app's limits would make of it) and `section_trace` (one section
  of one run every ~4 cm).
- The answer is structured (JSON schema). The command checks it the way the app does (limits, a
  rise of at most 25 % a step, track edits within 15 % / 15 cm) and recomputes the prediction.
