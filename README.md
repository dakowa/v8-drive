# V8 Drive

A web app that plays a real Ford Mustang GT500 V8 recording in an electric car (built for a 2021 Hyundai Ioniq 5 and iPhone). It reacts to the phone's accelerometer and gyroscope instantly, uses GPS to keep speed and gear honest, and can optionally read vehicle speed from a BLE OBD2 adapter.

Live: https://dakowa.github.io/v8-drive/

## Sound engine
Constant-RPM loops (on- and off-throttle) cut from the Mustang GT500 recordings (900–4,400 rpm), phase-aligned to one reference engine cycle and crossfaded by RPM and throttle, all locked to one crank-phase clock in `docs/engine-worklet.js` (AudioWorklet).

Engine pitch has an A/B test. A (as v3): sound RPM = RPM × pitch for everything, the idle included. B: same up to pitch 1.10; above that the idle stays at 1.10 and only the driving sound goes higher (rising as the idle fades out), and above 5,000 sound-RPM the sound rises at 40% of the rate, so no recording is sped up much past what was recorded. Pulse re-spacing (v4) was dropped: it sounded broken.

Extra engines (BMW M5 V10, Ferrari 458, Mercedes-AMG, Camaro) were tried in v4 from Wikimedia Commons recordings and removed in v5: they sounded bad and their separate idle recordings clashed. A granular-replay engine (B) was tried in v1–v2 and dropped as too metallic.

## Drives
Drives record automatically while the engine runs (IndexedDB on the phone, 25 Hz engine/motion rows plus 1 Hz GPS fixes with position). The Drives tab plots the route on OpenStreetMap (Leaflet), coloured by acceleration band, speed, RPM, gear or throttle, with linked speed/accel/RPM charts, best 0–50/0–100 and time spent in each shift band. JSON export/import.

## Vehicle model (`docs/vehicle.js`)
- Fusion: iOS linear acceleration projected on the learned forward axis (preset → learned on first pull-away → refined from GPS acceleration), integrated for instant speed, corrected by latency-compensated GPS speed (or OBD2 010D), zero-velocity updates at standstill.
- Drivetrain: 2018+ Mustang GT, MT82 6-speed (3.66/2.43/1.69/1.31/1.00/0.65, 3.55 axle) or 10R80 10-speed (4.696…0.636, 3.15 axle), 255/40R19.
- Upshift RPM follows acceleration: gentle ≤0.10 g → 2000, medium 0.20 g → 3000, hard 0.32 g → 4000, maximum ≥0.45 g → 5000 (adjustable). Acceleration is judged relative to what the car can deliver at the current speed (power-limited at motorway speeds).
- Slowing down: rev-matched downshifts once revs fall below a set point (2000–4000, slider), optionally raised after hard driving.
- Sport mode: keeps revs above a set floor (2000–4000) by holding lower gears, except below a set speed (default 10 km/h).
- Low speed (5–15 km/h) A/B: A = clutch model with the idle recording; B = in gear, engine sound takes over once rolling.
- Kickdown from 3rd gear up: one gear on a firm press, two gears at full demand, the target gear chosen in one 150 ms decision and never past the target RPM.
- Simulator: bottom 20% of the pedal (and letting go) is lift-off regen, Ioniq 5 level 3 (~0.18 g).

## Idle
A dedicated idle player loops a long, seamless real idle (1964 Chrysler V8 at the tailpipe, `tools/build_idles.py`) and crossfades into the engine sound as revs or throttle rise. Mustang 5.0, Corvette and re-sequenced GT500 idles were tried and dropped.

## Rebuilding the sample banks
`tools/build_banks.py` (numpy, scipy, imageio-ffmpeg) reads `tools/cache/*.ogg` and the measured RPM tracks in `tools/data/tracks.json`, writes `docs/audio/bankA.{wav,json}`.

## Credits
Recordings (Freesound): Mustang GT500 by VacekH, CC0 (205501, 205503, 205508, 205510, 205511). Idle: 1964 Chrysler Windsor by lonemonk, CC BY 4.0 (240671).

Map data © OpenStreetMap contributors.
