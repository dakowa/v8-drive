"""RPM tracker for engine recordings, using engine-order templates.

For every 20 ms frame, each candidate RPM is scored by the whitened spectral energy at the
harmonic orders that engine type produces (cross-plane V8: half orders, firing = 4th; flat-plane
V8: even orders; V10 with split exhaust: 2.5-order family). A Viterbi pass then picks the most
continuous path. Templates avoid the octave errors a plain pitch tracker makes on engines.

Usage: python track_rpm.py <engine-id> [--plot out.png]   (segments come from engines.json)
"""
import json, os, sys
import numpy as np
from scipy.signal import stft
from scipy.ndimage import uniform_filter1d

ROOT = os.path.dirname(os.path.abspath(__file__))
HOP = 0.02

ORDERS = {
    # (order, weight)
    'v8_cross': [(0.5, .3), (1, .5), (1.5, .5), (2, 1), (2.5, .5), (3, .6), (3.5, .5), (4, 1.2), (5, .6),
                 (6, .6), (7, .4), (8, .9), (10, .3), (12, .4)],
    'v8_flat': [(2, 1), (4, 1.2), (6, .7), (8, .9), (10, .4), (12, .5), (1, .2), (3, .2)],
    'v10': [(2.5, 1), (5, 1.2), (7.5, .9), (10, .8), (12.5, .5), (15, .5), (1.5, .3), (3.5, .3)],
}


def load(path, sr=22050):
    import subprocess
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        ff = 'ffmpeg'
    raw = subprocess.run([ff, '-v', 'quiet', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                         capture_output=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def track(x, sr, kind, rmin, rmax, slew=7000, nper=4096):
    hop = int(HOP * sr)
    f, t, Z = stft(x, sr, nperseg=nper, noverlap=nper - hop, boundary='even')
    A = np.log(np.abs(Z) + 1e-7)
    W = np.maximum(A - uniform_filter1d(A, size=max(3, int(30 / f[1])), axis=0), 0)
    R = np.exp(np.linspace(np.log(rmin), np.log(rmax), 400))
    sc = np.zeros((len(R), len(t)))
    df = f[1]
    for o, w in ORDERS[kind]:
        fr = R / 60 * o
        ok = fr < f[-1] - 2 * df
        idx = np.clip(np.round(fr / df).astype(int), 1, len(f) - 2)
        # max over +-1 bin for tolerance
        v = np.maximum(np.maximum(W[idx - 1], W[idx]), W[idx + 1])
        sc[ok] += w * v[ok]
    z = (sc - sc.mean(0)) / (sc.std(0) + 1e-9)
    # Viterbi on log-rpm grid
    step = np.log(R[1] / R[0])
    T = len(t)
    D = z[:, 0].copy()
    B = np.zeros((len(R), T), int)
    for k in range(1, T):
        # allowed change: slew rpm/s at this rpm -> in log units ~ slew*HOP/R
        best = np.full(len(R), -1e9); arg = np.zeros(len(R), int)
        J = 6
        for d in range(-J, J + 1):
            sh = np.roll(D, d)
            if d > 0: sh[:d] = -1e9
            elif d < 0: sh[d:] = -1e9
            pen = 0.12 * abs(d)
            # forbid jumps larger than slew allows
            lim = (slew * HOP / R) / step
            sh = np.where(abs(d) <= np.maximum(lim, 1), sh - pen, -1e9)
            m = sh > best
            best = np.where(m, sh, best); arg = np.where(m, np.arange(len(R)) - d, arg)
        D = best + z[:, k]
        B[:, k] = arg
    path = np.zeros(T, int); path[-1] = int(np.argmax(D))
    for k in range(T - 1, 0, -1):
        path[k - 1] = B[path[k], k]
    return t, R[path], z[path, np.arange(T)], (f, A, R, z)


def follow(x, sr, anchors, order, t_off=0.0, nper=2048):
    """Follow the spectral peak near hand-read anchor points [(t, Hz of a line of this order)]."""
    hop = int(HOP * sr)
    f, t, Z = stft(x, sr, nperseg=nper, noverlap=nper - hop, boundary='even')
    A = np.abs(Z)
    an = np.array(anchors, float)
    out = np.zeros(len(t))
    for k, tt in enumerate(t):
        c = np.exp(np.interp(tt + t_off, an[:, 0], np.log(an[:, 1])))
        idx = np.where((f > c * 0.88) & (f < c * 1.12))[0]
        if len(idx) == 0:
            out[k] = c; continue
        i = idx[np.argmax(A[idx, k])]
        if 0 < i < len(f) - 1:
            l, m, r = np.log(A[i - 1:i + 2, k] + 1e-9)
            d = 0.5 * (l - r) / (l - 2 * m + r) if (l - 2 * m + r) != 0 else 0
            out[k] = (i + np.clip(d, -0.5, 0.5)) * f[1]
        else:
            out[k] = f[i]
    from scipy.ndimage import median_filter
    out = median_filter(out, 5)
    Al = np.log(A + 1e-7)
    return t, out * 60 / order, np.ones(len(t)), (f, Al, None, None)


def main():
    eid = sys.argv[1]
    cfg = json.load(open(os.path.join(ROOT, 'engines.json')))[eid]
    out = {}
    plots = []
    for src in cfg['sources']:
        x = load(os.path.join(ROOT, 'cache', src['file']))
        sr = 22050
        res = []
        for seg in src['segments']:
            t0, t1 = seg['t0'], seg['t1']
            pad = 0.2
            a = int(max(0, t0 - pad) * sr); b = int((t1 + pad) * sr)
            if 'anchors' in seg:
                t, rpm, conf, dbg = follow(x[a:b], sr, seg['anchors'], seg['order'], t_off=a / sr)
            else:
                t, rpm, conf, dbg = track(x[a:b], sr, cfg['kind'], seg.get('rmin', 500), seg.get('rmax', 9500),
                                          seg.get('slew', 7000))
            t = t + a / sr
            keep = (t >= t0) & (t <= t1)
            res.append([[round(float(a_), 3), round(float(r_), 1)] for a_, r_ in zip(t[keep], rpm[keep])])
            plots.append((src['file'], t0, t1, t, rpm, keep, dbg, cfg['kind']))
        out[src['file']] = res
    json.dump(out, open(os.path.join(ROOT, 'data', f'tracks_{eid}.json'), 'w'))
    if '--plot' in sys.argv:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(len(plots), 1, figsize=(18, 3.6 * len(plots)), squeeze=False)
        for a_, (fn, t0, t1, t, rpm, keep, (f, A, R, z), kind) in zip(ax[:, 0], plots):
            fire = {'v8_cross': 4, 'v8_flat': 4, 'v10': 5}[kind]
            m = f < max(700, rpm[keep].max() / 60 * fire * 1.3)
            a_.pcolormesh(t, f[m], A[m], shading='auto', vmin=A[m].max() - 7, cmap='magma')
            a_.plot(t[keep], rpm[keep] / 60 * fire, 'c', lw=.9)
            a_.plot(t[keep], rpm[keep] / 60 * fire / 2, 'g--', lw=.6)
            a_.set_title(f'{fn} {t0}-{t1}  cyan = firing order from tracked rpm, max {rpm[keep].max():.0f}')
        plt.tight_layout()
        plt.savefig(sys.argv[sys.argv.index('--plot') + 1], dpi=45)
    print(eid, {k: [(s[0][0], s[-1][0], min(r for _, r in s), max(r for _, r in s)) for s in v] for k, v in out.items()})


if __name__ == '__main__':
    main()
