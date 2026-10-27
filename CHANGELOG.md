# Changelog

Every release is a git tag (`v1`, `v2`, …), and every earlier release stays playable on the
phone at https://dakowa.github.io/v8-drive/v/N/ (e.g. `/v/3/`). The list of all of them is at
https://dakowa.github.io/v8-drive/v/, which the version badge in the header opens. Each archived
release keeps its own settings and drives, so it sounds exactly as it shipped.

How releases are made (`tools/release.sh <N>`):

- Each feature is its own commit and never touches the `?v=` strings, so `git revert <commit>`
  undoes exactly that feature.
- The release commit bumps the asset version (`?v=N`, `VERSION` in app.js), rebuilds
  `docs/v/` (`tools/build_versions.py`: earlier releases from their tags, the list from this
  file), and is tagged `vN`.
- Each drive log records `appVersion`, so analysis knows which release was driven.

From v9 on, the release number, the asset version and the tag are the same number. Before
that they drifted: v4 shipped as asset version 5 and v5 as asset version 6, and there is no v6.

## v12 (tag v12)
- Drive uploads: ticking "Upload after every drive" opens a one-time setup instead of silently
  waiting for a token: GitHub's token page opens pre-filled (pick the logs repo, Generate,
  Copy), then one Paste tap checks and saves it. After that the tickbox is all it takes.
  The token can't be built into the app: its code is public and GitHub revokes tokens found
  in public code.

## v11 (tag v11)
- Steady rpm (cruising, motorway) no longer pulses: the short engine loops used to repeat
  exactly every ~0.75 s. The recorded engine cycles now play in an ever-changing order, and a
  steady rpm plays one recording instead of a blend of two.
- Cruising: small jitter in the throttle estimate (road, phone mount) is averaged out so the
  sound doesn't wobble between on- and off-throttle recordings; revs glide over the 1 Hz GPS
  speed corrections. Pressing or lifting still responds at once; launches are unchanged.

## v10 (tag v10)
- Gentle pull-away: the revs ease up from idle with the pedal instead of jumping from about
  1000 to 1500 rpm in a tenth of a second. A firm or full throttle launches as before.
- Low-rpm sound test (Settings, "Low-rpm sound (test)"), four different takes on 1100–2100 rpm,
  everything above unchanged: **A** the GT500 as in v9 (default), **B** a Ford Galaxie V8 held
  at steady revs 1200–1840 rpm, **C** a Chevy Caprice V8 at steady revs 1150–1550 rpm, **D** the
  GT500's clean 2100 rpm sound slowed down below that. B and C are different engines, tone-matched
  to the GT500. Temporary: the losers go once you pick one.
- Upshift rpm adjustable per tier (gentle, medium, firm, max), 1500–6000 rpm, next to each
  g slider; moving one keeps the others in order. Above 5000 rpm the sound rises more slowly
  (the recordings end near 4400), so a 6000 shift sounds like about 5500.
- Only real drives are recorded: nothing while the simulator is on.
- The "Sounded wrong / great" buttons are gone; say what sounded off instead.
- **Verdict:** idle, acceleration and deceleration really good; steady rpm awful
  (oscillating, didn't sound recorded).

## v9 (tag v9)
- One engine pitch slider again (the v5 "Pitch test" A/B is gone). Nothing plays faster than at
  pitch 1.10: the idle stays at most 1.10× its recorded speed, and above 1.10 the top end
  flattens out near 4300 rpm, where the GT500 recordings end, instead of running the loops up
  to 1.8× too fast.
- 5–15 km/h: crawling on a light throttle plays the real idle (the clutch slips just above
  idle); a firm throttle or 16 km/h hands over to the engine. Idle and engine switch with
  hysteresis and a short crossfade, never a lingering blend of a sped-up idle and the engine.
  Pulling away slips at 1500 rpm or more. The low-speed A/B toggle is gone.
- The 1100–2100 rpm loops are re-picked for the least RPM drift within each loop; 2350 rpm
  and up are unchanged.
- Idle picker back, as in v3: I3 Chrysler (default) or I1 Mustang 5.0.
- Version control: release tags, this changelog, every earlier release playable at /v/N/ with
  its own settings and drives, listed at /v/ (version badge in the header).
- A second, fully recorded engine was looked for and not added: the best candidate (a Ford
  Galaxie V8 with steady free-revs) has gaps of 18–38% between its recorded speeds and no
  on-throttle sound, so it would have needed stretching or stitching.

## v8 (tag v8)
- Robust drive uploads: drive files named to the second, "already exists" counts as uploaded,
  drives from before v7 upload too.

## v7 (tag v7)
- Drive feedback loop: raw motion, GPS fix age, settings changes and background events in
  each log; "Sounded wrong / great" marks; optional upload to the private repo
  dakowa/v8-drive-logs; analyzer and replay tools (ANALYSIS.md).

## v5 (tag v5, asset version 6)
- Back to one engine: Mustang GT500 loop bank + Chrysler idle. The v4 engines were removed.
- Pitch A/B toggle in Settings (A = v3 exact, B = idle capped at 1.10).
- **Verdict:** 5–15 km/h sounds terrible; pitch is only good from 0.7 to 1.1, horrible above.
  The second pitch control (the A/B toggle next to the slider) was clutter: the ask had been
  to restore the v3 pitch, not add an option.

## v4 (tag v4, asset version 5)
- Four more engines (BMW M5 V10, Ferrari 458, Mercedes-AMG, Camaro), Drives tab with map,
  sport mode, downshift slider, low-speed A/B (A clutch + idle, B in gear), formant-preserving
  pitch.
- **Verdict:** the extra engines sounded bad and clashed with the idle; the pitch broke.
  Downshift slider, "raise after hard driving", sport mode and "except below" worked great.

## v3 (tag v3)
- Loop-bank engine only; idle picker with I3 Chrysler (default) and I1 Mustang 5.0.
- **Verdict:** "really good" on a real drive. Pitch 0.7–1.1 great; 5–15 km/h felt unnatural.

## v2 (tag v2)
- Idle picker with four real idle recordings, 5000 rpm shift tier, kickdown, regen level 3.
- **Verdict:** I3 Chrysler best, I1 Mustang fine, I2 and I4 bad; loop bank good, granular too
  metallic.

## v1 (tag v1)
- First version: A = phase-aligned loop bank, B = granular replay, both from CC0 Mustang
  GT500 recordings.
- **Verdict:** both idles metallic (beep in A, tin can in B).
