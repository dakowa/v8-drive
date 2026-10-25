# V8 Drive

A web app that plays a real Ford Mustang GT500 V8 recording in an electric car (built for a 2021 Hyundai Ioniq 5 and iPhone). It reacts to the phone's accelerometer and gyroscope instantly, uses GPS to keep speed and gear honest, and can optionally read vehicle speed from a BLE OBD2 adapter.

Live: https://dakowa.github.io/v8-drive/ (`#A` / `#B` select the sound engine).

## Sound engines (A/B)
- **A – loop bank:** constant-RPM loops (on- and off-throttle, 900–4400 rpm) cut from the recordings, phase-aligned to one reference engine cycle and crossfaded by RPM and throttle.
- **B – granular replay:** the continuous recordings with a 10 ms RPM/load map; every engine cycle a grain continues the recording where it matches, or jumps to the best-matching moment, resampled to the exact target RPM.

Both share one crank-phase clock in `docs/engine-worklet.js` (AudioWorklet).

## Vehicle model (`docs/vehicle.js`)
- Fusion: iOS linear acceleration projected on the learned forward axis (preset → learned on first pull-away → refined from GPS acceleration), integrated for instant speed, corrected by latency-compensated GPS speed (or OBD2 010D), zero-velocity updates at standstill.
- Drivetrain: 2018+ Mustang GT, MT82 6-speed (3.66/2.43/1.69/1.31/1.00/0.65, 3.55 axle) or 10R80 10-speed (4.696…0.636, 3.15 axle), 255/40R19.
- Upshift RPM follows acceleration: gentle ≤0.10 g → 2000, medium 0.20 g → 3000, hard ≥0.32 g → 4000 (adjustable).

## Rebuilding the sample banks
`tools/build_banks.py` (numpy, scipy, imageio-ffmpeg) reads `tools/cache/*.ogg` and the measured RPM tracks in `tools/data/tracks.json`, writes `docs/audio/bank{A,B}.{wav,json}`.

## Credits
Recordings: Mustang GT500 by VacekH on Freesound, CC0 (sounds 205501, 205503, 205508, 205510, 205511).
