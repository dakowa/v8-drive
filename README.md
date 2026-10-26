# V8 Drive

A web app that plays a real Ford Mustang GT500 V8 recording in an electric car (built for a 2021 Hyundai Ioniq 5 and iPhone). It reacts to the phone's accelerometer and gyroscope instantly, uses GPS to keep speed and gear honest, and can optionally read vehicle speed from a BLE OBD2 adapter.

Live: https://dakowa.github.io/v8-drive/

## Sound engine
Constant-RPM loops (on- and off-throttle, 900–4400 rpm) cut from the recordings, phase-aligned to one reference engine cycle and crossfaded by RPM and throttle, all locked to one crank-phase clock in `docs/engine-worklet.js` (AudioWorklet). A granular-replay engine (B) was tried in v1–v2 and dropped as too metallic.

## Vehicle model (`docs/vehicle.js`)
- Fusion: iOS linear acceleration projected on the learned forward axis (preset → learned on first pull-away → refined from GPS acceleration), integrated for instant speed, corrected by latency-compensated GPS speed (or OBD2 010D), zero-velocity updates at standstill.
- Drivetrain: 2018+ Mustang GT, MT82 6-speed (3.66/2.43/1.69/1.31/1.00/0.65, 3.55 axle) or 10R80 10-speed (4.696…0.636, 3.15 axle), 255/40R19.
- Upshift RPM follows acceleration: gentle ≤0.10 g → 2000, medium 0.20 g → 3000, hard 0.32 g → 4000, maximum ≥0.45 g → 5000 (adjustable). Acceleration is judged relative to what the car can deliver at the current speed (power-limited at motorway speeds).
- Slowing down: rev-matched downshifts once revs fall below 2000–4000 (following recent driving) or a fixed 2000.
- Kickdown from 3rd gear up: one gear on a firm press, two gears at full demand, the target gear chosen in one 150 ms decision and never past the target RPM.
- Simulator: bottom 20% of the pedal (and letting go) is lift-off regen, Ioniq 5 level 3 (~0.18 g).

## Idle
A dedicated idle player loops a long, seamless real idle and crossfades into the engine sound as revs or throttle rise. Variants: I3 1964 Chrysler V8 at the tailpipe (default) and I1 1985 Ford Mustang 5.0 (`tools/build_idles.py`). Corvette and re-sequenced GT500 idles were tried and dropped.

## Rebuilding the sample banks
`tools/build_banks.py` (numpy, scipy, imageio-ffmpeg) reads `tools/cache/*.ogg` and the measured RPM tracks in `tools/data/tracks.json`, writes `docs/audio/bankA.{wav,json}`.

## Credits
Recordings (Freesound): Mustang GT500 by VacekH, CC0 (205501, 205503, 205508, 205510, 205511). Idles: 1964 Chrysler Windsor by lonemonk, CC BY 4.0 (240671); 1985 Ford Mustang by lmbubec, CC0 (119449).
