# V8 Drive

A web app that plays a real Ford Mustang GT500 V8 recording in an electric car (built for a 2021 Hyundai Ioniq 5 and iPhone). It reacts to the phone's accelerometer and gyroscope instantly, uses GPS to keep speed and gear honest, and can optionally read vehicle speed from a BLE OBD2 adapter.

Live: https://dakowa.github.io/v8-drive/

## Sound engine
Constant-RPM loops (on- and off-throttle) cut from the Mustang GT500 recordings (900–4,400 rpm), phase-aligned to one reference engine cycle and crossfaded by RPM and throttle, all locked to one crank-phase clock in `docs/engine-worklet.js` (AudioWorklet).

Engine pitch (one slider, 0.70–1.40): sound RPM = RPM × pitch, with one limit: nothing plays faster than at pitch 1.10, the highest that sounded natural (v5–v8 showed that above it the idle got sped up and the loops ran up to 1.8× past the recordings). So the idle plays at most 1.10× its recorded speed, and above pitch 1.10 the sound flattens out near 4,300 rpm, where the recordings end. Pulse re-spacing (v4) was dropped: it sounded broken.

Low-rpm test (v10): the GT500 recordings have no steady stretches between idle and ~2000 rpm, only fast sweeps, and gentle acceleration sounded bad there. The "Low-rpm sound (test)" picker on the Drive page (`lowSound` setting, recorded in each drive log) switches between four distinctly different takes on 1100–2100 rpm: **A** the GT500 loops as in v9 (slices of pull-aways); **B** steady holds of a 1970s Ford Galaxie V8 (1200–1840 rpm, GT500 from 2100); **C** steady holds of a Chevrolet Caprice V8 (1150–1550 rpm, GT500 from 1700); **D** the clean GT500 2100 rpm loop slowed down below 2100. The Galaxie and Caprice holds are free revs or light load, so their on-throttle layer is the same sound, louder. The picker goes once one is chosen.

Idle and engine switch with hysteresis (engine above 1.40× idle RPM or load 0.30, back below 1.30× and 0.20) and a short timed crossfade (50 ms in, 300 ms out), so the sound is never a lingering blend of a sped-up idle and the engine.

Extra engines (BMW M5 V10, Ferrari 458, Mercedes-AMG, Camaro) were tried in v4 from Wikimedia Commons recordings and removed in v5: they sounded bad and their separate idle recordings clashed. A granular-replay engine (B) was tried in v1–v2 and dropped as too metallic.

## Drives
Drives record automatically while the engine runs (IndexedDB on the phone). Each log holds ~20 Hz engine rows, the raw phone motion (~60 Hz), 1 Hz GPS fixes with position and fix age, gear changes, mid-drive setting changes, and the driver's **Sounded wrong / Sounded great** marks (big buttons under Start). The Drives tab plots the route on OpenStreetMap (Leaflet), coloured by acceleration band, speed, RPM, gear or throttle, with linked speed/accel/RPM charts, best 0–50/0–100 and time spent in each shift band. Marks show on the map. Send (share sheet), upload, JSON export/import.

## Feedback loop
With *Send drives for analysis* on, every finished real drive (GPS speed above 15 km/h, so never the simulator) is gzipped and uploaded to a private GitHub repo with a fine-grained token kept only on the phone. Drives the app never got to stop (phone locked) are closed and uploaded the next time it opens. On the computer, `tools/pull_drives.py` fetches them, `tools/analyze_drive.py` writes a report per drive, and `docs/dev/replay.js` re-runs a drive through the real Fusion + Drivetrain with different settings and renders any moment to audio. See [ANALYSIS.md](ANALYSIS.md). Python tools need `pip install -r tools/requirements.txt`.

## Vehicle model (`docs/vehicle.js`)
- Fusion: iOS linear acceleration projected on the learned forward axis (preset → learned on first pull-away → refined from GPS acceleration), integrated for instant speed, corrected by latency-compensated GPS speed (or OBD2 010D), zero-velocity updates at standstill.
- Drivetrain: 2018+ Mustang GT, MT82 6-speed (3.66/2.43/1.69/1.31/1.00/0.65, 3.55 axle) or 10R80 10-speed (4.696…0.636, 3.15 axle), 255/40R19.
- Upshift RPM follows acceleration: gentle ≤0.10 g → 2000, medium 0.20 g → 3000, hard 0.32 g → 4000, maximum ≥0.45 g → 5000. Both the acceleration and the upshift rpm of each tier are adjustable in Settings (rpm 1500–6000; moving one tier pushes the others so they stay in order). The recordings end near 4,400 rpm, so above 5,000 the sound rises more slowly (6,000 sounds like about 5,500). Acceleration is judged relative to what the car can deliver at the current speed (power-limited at motorway speeds).
- Slowing down: rev-matched downshifts once revs fall below a set point (2000–4000, slider), optionally raised after hard driving.
- Sport mode: keeps revs above a set floor (2000–4000) by holding lower gears, except below a set speed (default 10 km/h).
- Low speed: crawling below 13 km/h on a light throttle, the clutch slips just above idle and the real idle recording plays; a firm throttle (or 16 km/h) ends it, with a gap between the thresholds so a noisy throttle estimate cannot flap it. Pulling away, revs follow the throttle: a gentle pedal lets them rise over about a second, a firm one bites at once (v9 jumped straight to 1500 rpm). (v4–v8 had a low-speed A/B here.)
- Kickdown from 3rd gear up: one gear on a firm press, two gears at full demand, the target gear chosen in one 150 ms decision and never past the target RPM.
- Simulator: bottom 20% of the pedal (and letting go) is lift-off regen, Ioniq 5 level 3 (~0.18 g).

## Idle
A dedicated idle player loops a long, seamless real idle (`tools/build_idles.py`) and crossfades into the engine sound as revs or throttle rise. The "Idle sound" picker on the Drive page chooses the recording, as in v3: I3, a 1964 Chrysler V8 at the tailpipe (default), or I1, a 1985 Ford Mustang 5.0. The choice is saved as the `sound` setting and recorded in each drive log; picking another idle while one plays crossfades over 150 ms. Corvette, Camaro and re-sequenced GT500 idles were tried and dropped.

## Rebuilding the sample banks
`tools/build_banks.py` (numpy, scipy, imageio-ffmpeg) reads `tools/cache/*.ogg` and the measured RPM tracks in `tools/data/tracks.json`, writes `docs/audio/bankA.{wav,json}`. The GT500 recordings have no steady stretches between idle and ~2000 rpm, only sweeps, so the 1100–2100 rpm loops are picked for the least RPM variation within 6% of their target (from v9), and off-throttle loops there use the on-throttle sound at the right RPM rather than an off-throttle one 10–30% off. `tools/build_low.py` builds the low-rpm test variants B and C (`docs/audio/low{B,C}.{wav,json}`) from the steady holds listed in `tools/data/holds.json`.

## Credits
Recordings (Freesound): Mustang GT500 by VacekH, CC0 (205501, 205503, 205508, 205510, 205511). Idles: 1964 Chrysler Windsor by lonemonk, CC BY 4.0 (240671); 1985 Ford Mustang 5.0 by lmbubec, CC0 (119449). Low-rpm test: 1970s Ford Galaxie V8 by snafic, CC BY 4.0 (512704); Chevrolet Caprice V8 by romanholtwick, CC0 (391671).

Map data © OpenStreetMap contributors.
