"""Build the low-rpm sound variants B and C (v10 A/B test) from steady holds of other real V8s.

The GT500 recordings have no steady stretches below ~2000 rpm, only fast sweeps, so the loop
bank's 1100-1900 rpm loops (variant A) are slices of sweeps. B and C replace them with loops
cut from engines held at a steady speed:

  B  Ford Galaxie V8 (1970s), snafic, Freesound 512704, CC BY 4.0: 1207-1841 rpm, free revs
  C  Chevrolet Caprice V8, romanholtwick, Freesound 391671, CC0: 1153-1552 rpm, partly
     driving away

Each hold (tools/data/holds.json, measured with the same firing-harmonic tracker as the GT500)
becomes one constant-RPM loop, as long as the hold allows, resampled in the crank-angle domain
and phase-aligned to the GT500 reference cycle like bank A. The same loop serves the on- and
off-load layers, at the bank's on/off levels.

Tone: both recordings are far brighter than the GT500's (20-35 dB more above 800 Hz; the GT500
mic hears mostly exhaust), so each variant gets one fixed EQ that matches its average spectrum
to the GT500 loops at 1500-2350 rpm, the handover zone. The loops are periodic, so the EQ is
applied as a zero-phase gain on each loop's spectrum and the seams stay seamless. Variant D needs no audio (the app plays the GT500
2100 rpm loop slowed down).

Outputs (docs/audio/): lowB.wav/json, lowC.wav/json (json `gain`: multiply the samples by it)
"""
import json, os
import numpy as np
from scipy.signal import resample_poly

from build_banks import (Segment, load, cycle_offset, norm_gain, write_wav, OUT, SR)

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_CYCLES = 40        # ~2-3 s per loop is plenty of variety
EQ_RANGE = (-40.0, 12.0)   # dB, limits of the tone match


def smooth_db(y):
    """Third-octave smoothed power spectrum (dB) of a loop on the common grid FGRID."""
    f = np.fft.rfftfreq(len(y), 1 / SR)
    p = np.abs(np.fft.rfft(y)) ** 2 / len(y)
    out = np.empty(len(FGRID))
    for i, fc in enumerate(FGRID):
        m = (f >= fc / 2 ** (1 / 6)) & (f < fc * 2 ** (1 / 6))
        out[i] = 10 * np.log10(p[m].mean() + 1e-15) if m.any() else np.nan
    return out


FGRID = 20 * 2 ** (np.arange(0, 30) / 3)    # 20 Hz .. ~10 kHz, third octaves


def target_db():
    """Average tone of the GT500 on-load loops at 1500-2350 rpm (bank A as built)."""
    import soundfile as sf
    j = json.load(open(os.path.join(OUT, 'bankA.json')))
    x, _ = sf.read(os.path.join(OUT, 'bankA.wav'))
    ls = [l for l in j['loops'] if l['layer'] == 'ON' and 1500 <= l['rpm'] <= 2350]
    return np.nanmean([smooth_db(x[l['start']:l['start'] + l['length']]) for l in ls], 0)


def tone_match(bodies, tgt):
    """Apply one EQ to all loops so their average tone matches tgt (relative levels kept)."""
    src = np.nanmean([smooth_db(b / np.sqrt(np.mean(b ** 2))) for b in bodies], 0)
    t = tgt - 10 * np.log10(np.nansum(10 ** (tgt / 10)))
    s = src - 10 * np.log10(np.nansum(10 ** (src / 10)))
    # smoothed over an octave and a third: a broad tone curve, not one that carves harmonics
    corr = np.convolve(np.pad(np.nan_to_num(t - s), 2, mode='edge'), np.ones(5) / 5, 'valid')
    corr = np.clip(corr, *EQ_RANGE)
    out = []
    for b in bodies:
        f = np.fft.rfftfreq(len(b), 1 / SR)
        g = 10 ** (np.interp(np.log2(np.maximum(f, 1)), np.log2(FGRID), corr) / 20)
        out.append(np.fft.irfft(np.fft.rfft(b) * g, n=len(b)))
    print('  EQ dB at', ', '.join(f'{fc:.0f} Hz {c:+.0f}' for fc, c in zip(FGRID[::3], corr[::3])))
    return out


def reference():
    """GT500 reference cycle shape (as in build_banks.main)."""
    track = json.load(open(os.path.join(ROOT, 'data', 'tracks.json')))['205511'][0]
    seg = Segment('205511', load('205511'), track)
    i = int((9.5 - seg.t0) * SR)
    return seg.angle_cycles(np.floor(seg.phi[i]), 6).mean(0)


def build(variant, holds, ref, tgt):
    loops, audio, pos = [], [], 0
    xs, bodies, meta = {}, [], []
    for h in holds:
        fid = h['src']
        if fid not in xs:
            xs[fid] = load(fid)
        s = Segment(fid, xs[fid], h['track'])
        P = float(np.median(s.rpm))
        Nc = int(round(SR * 120 / P))
        ncyc = int(min(4, np.floor(s.phi[-1]) - 1))
        off = cycle_offset(s.angle_cycles(1, ncyc).mean(0), ref)
        ph0 = 1 + off
        K = int(min(MAX_CYCLES, np.floor(s.phi[-1] - ph0) - 1))
        grid = ph0 + np.arange((K + 1) * Nc) / Nc
        idx = np.interp(grid, s.phi, np.arange(len(s.phi)))
        xu = resample_poly(s.x, 4, 1)
        y = np.interp(idx * 4, np.arange(len(xu)), xu)
        body, tail = y[:K * Nc].copy(), y[K * Nc:]
        fade = np.sin(np.linspace(0, np.pi / 2, Nc)) ** 2
        body[:Nc] = body[:Nc] * fade + tail[:Nc] * (1 - fade)
        bodies.append(body)
        meta.append((P, K, Nc, fid, s.t0))
        print(f'{variant} {P:6.0f} rpm  src {fid} t={s.t0:6.2f}  {K} cycles ({K * 120 / P:.1f} s)')
    for body, (P, K, Nc, fid, t0) in zip(tone_match(bodies, tgt), meta):
        for layer in ('ON', 'OFF'):
            b = body * norm_gain(body, layer)
            loops.append(dict(layer=layer, rpm=round(P), cycles=K, nc=Nc, start=pos, length=len(b),
                              src=fid, t=round(t0, 2)))
            audio.append(b)
            pos += len(b)
    y = np.concatenate(audio)
    # stored peak-normalised; `gain` restores the bank's levels (the app applies it)
    gain = max(1.0, np.abs(y).max() / 0.98)
    write_wav(os.path.join(OUT, f'low{variant}.wav'), y / gain)
    json.dump(dict(sr=SR, gain=round(gain, 4), loops=loops), open(os.path.join(OUT, f'low{variant}.json'), 'w'),
              separators=(',', ':'))


def main():
    ref, tgt = reference(), target_db()
    for variant, holds in json.load(open(os.path.join(ROOT, 'data', 'holds.json'))).items():
        build(variant, holds, ref, tgt)


if __name__ == '__main__':
    main()
