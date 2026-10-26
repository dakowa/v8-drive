# Drive analysis: how Claude improves V8 Drive from real drives

The phone records every drive. With upload on (Drives tab → *Send drives for analysis*), each
finished real drive goes to the private repo `dakowa/v8-drive-logs` as
`drives/v8drive-YYYYMMDDHHMMSS.json.gz`. Drives are never committed to this (public) repo:
`drives/` is gitignored.

## Steps (for Claude)

1. **Pull:** `python tools/pull_drives.py` downloads new drives into `drives/` (uses `gh`).
2. **Analyse:** `python tools/analyze_drive.py --new` writes `drives/reports/<drive>.md`, `.png`
   and `.json`. Read the md and look at the png. With several drives, compare their `.json`
   files: one drive is an anecdote, a pattern across drives is a finding.
3. **Look closer** where something is off. Use the browser preview (`.claude/launch.json`,
   server `v8drive`) and the replay tool from the page console:
   ```js
   const r = await import('./dev/replay.js');
   const d = await r.loadDrive('dev/drives/v8drive-….json.gz');
   r.check(d)                                 // replay vs log; should agree closely
   r.compare(d, r.replay(d, { gMed: 0.18 }))  // what a setting change would have done
   await r.renderSpan('mark1_now', d, t - 8, t + 3, { ...__v8.banks });            // as heard
   await r.renderSpan('mark1_B', d, t - 8, t + 3, { ...__v8.banks, over: {...} }); // proposed
   ```
   Renders are saved by `python tools/render_sink.py` (run it first) to `listen/render_<name>.wav`. Listen to them, or send them to
   the user as an A/B.
4. **Propose, don't silently change.** The user steers by A/B. Turn findings into either new
   defaults with numbers ("your pulls peak at 0.24 g median, so the 4k band at 0.32 g is
   almost never reached: suggest gFast 0.26"), or a new A/B variant with listening renders.
   Record decisions in memory and the README.

## What the report covers, and what it means

| Section | Look for | Typical action |
| --- | --- | --- |
| dataQuality | rowHz well under 20, gaps, `backgrounded`, linear accel missing | Drive data is unreliable there; ignore those stretches |
| speed.bestLagS vs settingGpsLatency | A consistent difference across drives | Change the `gpsLatency` default. The fused speed was itself corrected with the current setting, so the estimate leans toward it: trust it only when it differs consistently, and confirm with replay (`over: { gpsLatency }`, compare `rmsAtBest`) |
| speed.correctionJumpKmh | p90 above ~2 km/h | GPS corrections are audible as RPM steps; tune Fusion (`correct` gains) |
| accel.pullPeakG vs thresholds | Bands the driver never or always reaches | Move gSlow/gMed/gFast/gMax so 2k/3k/4k/5k shifts happen as intended |
| shifts.upRpm, hunting | Reversals within 3 s, upshift RPM far from intended | Drivetrain hysteresis or kickdown logic |
| rpm.soundRpmAboveTopLoopS | Many seconds past 4400 sound rpm | The recordings end there; above pitch 1.10 the sound flattens out |
| lowSpeed | Time and RPM at 5–15 km/h (`mode` is the A/B of drives before v9) | Compare drives across versions (appVersion) |
| marks | What happened in the 6 s before each "sounded wrong / great" tap | The best clue; replay and render those moments |

## The log format (version 3)

`{app: 'v8drive', version: 3, appVersion, settings, columns, rows, gpsColumns, gps, motionColumns, motion, events, …meta}`

- **rows** (~20 Hz): `t, v` fused speed m/s, `a` filtered accel (shifts), `aRaw`, `rpm`, `gear`,
  `load`, `aggr` (accel envelope, g), `aq` fast accel (throttle), `shift` (1 mid-shift).
- **gps** (~1 Hz): `t` arrival, `lat, lon, speed` m/s, `acc` m, `heading`, `age` (fix time = t − age).
- **motion** (every devicemotion event, ~60 Hz): linear accel `ax..az`, accel with gravity
  `gx..gz`, rotation rate `ra, rb, rg` deg/s. This is enough to re-run Fusion offline.
- **events** `[t, kind, …]`: `up/down/kickdown` (from, to, rpm); `mark` (wrong|great, rpm, gear,
  km/h); `set` (key, value) for settings changed mid-drive; `sim` (0/1); `obd` (speed);
  `hidden/visible`; `stop`.

Times are seconds from the start of the drive, on the phone's `performance.now()` clock.

## Automating it

`python tools/pull_drives.py && python tools/analyze_drive.py --new` is safe to run on a
schedule. It only reads the logs repo and writes under `drives/`. Proposals still go to the
user.
