"""Build the idle sound variants (real recordings only) for the idle picker.

Each variant is a long, seamless loop of a steady real idle: tonal whines are notched out,
rumble below 25 Hz removed, and the loop seam is placed where the tail best matches the head
(cross-correlation), then joined with a 1 s equal-power crossfade.

Writes docs/audio/idle_<id>.wav and docs/audio/idles.json.
"""
import json, os
import numpy as np
from scipy.signal import butter, sosfiltfilt, iirnotch, filtfilt, welch, medfilt
from build_banks import load, write_wav, SR, OUT

VARIANTS = [
    dict(id='I3', name='Chrysler V8 at the tailpipe', src='240671', t0=4.0, t1=34.0, rpm=805,
         credit='lonemonk, Freesound, CC BY 4.0'),
    dict(id='I1', name='Ford Mustang 5.0 (1985)', src='119449', t0=1.5, t1=17.6, rpm=705,
         credit='lmbubec, Freesound, CC0'),
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


def main():
    meta = []
    hp = butter(2, 25, 'highpass', fs=SR, output='sos')
    for v in VARIANTS:
        x = load(v['src'])[int(v['t0'] * SR):int(v['t1'] * SR)]
        x = sosfiltfilt(hp, x)
        x, tones = notch_tones(x)
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
