"""Build the idle sound variants (real recordings only) for the idle picker.

Each variant is a long, seamless loop of a steady real idle: tonal whines are notched out,
rumble below 25 Hz removed, and the loop seam is placed where the tail best matches the head
(cross-correlation), then joined with a 1 s equal-power crossfade.

I4 instead re-sequences the GT500's own idle cycle by cycle (only ~1.1 s of it exists), so it
stays the same car as the driving banks without an audible short loop.

Writes docs/audio/idle_<id>.wav and docs/audio/idles.json.
"""
import json, os
import numpy as np
from scipy.signal import butter, sosfiltfilt, iirnotch, filtfilt, welch, medfilt
from build_banks import load, write_wav, SR, OUT

VARIANTS = [
    dict(id='I1', name='Ford Mustang 5.0 (1985)', src='119449', t0=1.5, t1=17.6, rpm=705,
         credit='lmbubec, Freesound, CC0'),
    dict(id='I2', name='Chevrolet Corvette', src='637181', t0=2.0, t1=17.2, rpm=635,
         credit='kyles, Freesound, CC0'),
    dict(id='I3', name='Chrysler V8 at the tailpipe', src='240671', t0=4.0, t1=34.0, rpm=805,
         credit='lonemonk, Freesound, CC BY 4.0'),
    dict(id='I4', name='Mustang GT500 (same car as driving), re-sequenced', src='205511', t0=0.03, t1=1.15,
         rpm=950, credit='VacekH, Freesound, CC0', shuffle=True, lowpass=1500),
]
TARGET_DB = -20.0


def notch_tones(x):
    """Find narrow tonal peaks above 800 Hz (whines, beeps) and notch them out."""
    f, P = welch(x, SR, nperseg=8192)
    base = medfilt(10 * np.log10(P + 1e-20), 61)
    excess = 10 * np.log10(P + 1e-20) - base
    found = []
    for i in np.argsort(excess)[::-1]:
        if f[i] < 800 or excess[i] < 9:
            continue
        if all(abs(f[i] - g) > 60 for g in found):
            found.append(float(f[i]))
        if len(found) >= 8:
            break
    for f0 in found:
        b, a = iirnotch(f0, 25, SR)
        x = filtfilt(b, a, x)
    return x, sorted(round(g) for g in found)


def seamless_loop(x, xf_s=1.0):
    """Choose the loop end where the tail best matches the head, then crossfade it in."""
    xf = int(xf_s * SR)
    head = x[:xf]
    best, best_end = -1e9, len(x)
    search = int(0.25 * SR)
    for end in range(len(x) - search, len(x) + 1, 16):
        tail = x[end - xf:end]
        c = np.dot(head, tail) / (np.linalg.norm(head) * np.linalg.norm(tail) + 1e-9)
        if c > best:
            best, best_end = c, end
    y = x[:best_end - xf].copy()
    tail = x[best_end - xf:best_end]
    t = np.linspace(0, np.pi / 2, xf)
    y[:xf] = head * np.sin(t) + tail * np.cos(t)
    return y, best


def shuffle_cycles(x, rpm, seconds=24.0, seed=5):
    """Cut the idle into single engine cycles and re-sequence them randomly, aligned and crossfaded."""
    period = int(round(SR * 120 / rpm))
    # refine the period from the autocorrelation
    ac = np.correlate(x, x, 'full')[len(x) - 1:]
    lo, hi = int(period * 0.85), int(period * 1.15)
    period = lo + int(np.argmax(ac[lo:hi]))
    starts = [0]
    while starts[-1] + 2 * period < len(x):
        p = starts[-1] + period
        ref = x[starts[-1]:starts[-1] + period]
        w = int(period * 0.06)
        cs = [np.dot(ref, x[p + d:p + d + period]) for d in range(-w, w + 1)]
        starts.append(p - w + int(np.argmax(cs)))
    cycles = [x[s:s + period + period // 4] for s in starts]
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * SR) + 2 * period)
    xf = period // 4
    fade = np.sin(np.linspace(0, np.pi / 2, xf)) ** 2
    pos, last = 0, -1
    while pos + period + xf < len(out):
        k = rng.integers(len(cycles))
        if k == last:
            k = (k + 1) % len(cycles)
        last = k
        c = cycles[k].copy()
        c[:xf] *= fade
        c[-xf:] *= fade[::-1]
        out[pos:pos + len(c)] += c
        pos += period
    y = out[xf:int(seconds * SR)]
    return seamless_loop(y, 0.3)[0], len(cycles), period


def main():
    meta = []
    hp = butter(2, 25, 'highpass', fs=SR, output='sos')
    for v in VARIANTS:
        x = load(v['src'])[int(v['t0'] * SR):int(v['t1'] * SR)]
        x = sosfiltfilt(hp, x)
        x, tones = notch_tones(x)
        if v.get('lowpass'):
            # the GT500 idle has intermittent 2-4 kHz chirps (the "beep"); real idle content sits below
            x = sosfiltfilt(butter(8, v['lowpass'], fs=SR, output='sos'), x)
        if v.get('shuffle'):
            y, ncyc, per = shuffle_cycles(x, v['rpm'])
            info = f'{ncyc} cycles of {per / SR * 1000:.0f} ms'
        else:
            y, corr = seamless_loop(x)
            info = f'seam corr {corr:.2f}'
        y *= 10 ** (TARGET_DB / 20) / np.sqrt(np.mean(y ** 2))
        peak = np.abs(y).max()
        if peak > 0.97:
            y *= 0.97 / peak
        fn = f"idle_{v['id']}.wav"
        write_wav(os.path.join(OUT, fn), y)
        meta.append(dict(id=v['id'], name=v['name'], rpm=v['rpm'], file=fn, credit=v['credit'],
                         seconds=round(len(y) / SR, 2)))
        print(v['id'], v['name'], f'{len(y) / SR:.1f}s', info, 'notched', tones)
    json.dump(dict(sr=SR, idles=meta), open(os.path.join(OUT, 'idles.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
