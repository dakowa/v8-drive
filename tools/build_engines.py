"""Build loop banks + idles for the extra engines listed in engines.json.

Same method as the Mustang bank (build_banks.py): angle-domain, phase-aligned constant-RPM
loops cut from real recordings. Unlike the Mustang bank, a loop is only made where the
recording really passes that RPM (within 6%); the app covers gaps with formant-preserving
pulse re-spacing instead of stretching a far-away loop.

Writes docs/audio/bank_<id>.wav, docs/audio/idle_<id>.wav and docs/audio/engines.json
(which also lists the Mustang GT500 bank).
"""
import json, os, shutil
import numpy as np
from scipy.signal import resample_poly, butter, sosfiltfilt
from build_banks import Segment, load as load_id, classify, cycle_offset, norm_gain, write_wav, SR, OUT, CYC
from build_idles import notch_tones, seamless_loop
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
TOL = 0.06
GAIN = {'m5': 0.8, 'amg': 0.85}   # peakier recordings: trim so they sit level with the Mustang

IDLES = {   # engine -> (file, t0, t1)
    'm5': ('m5e60.opus', 0.8, 9.8),
    'f458': ('f458s.opus', 2.2, 9.8),
    'amg': ('blackseries.opus', 25.0, 32.0),
    'camaro': ('z28.opus', 3.0, 7.4),
}
PULSES = {'v8_cross': 8, 'v8_flat': 8, 'v10': 10}
CREDITS = {
    'm5': 'BMW M5 E60: asTUBE (YouTube) via Wikimedia Commons, CC BY 3.0',
    'f458': 'Ferrari 458 Speciale: TvdL Films (YouTube) via Wikimedia Commons, CC BY 3.0',
    'amg': 'Mercedes-Benz SLS AMG (6.2 AMG V8, same family as the C63): Edvvc via Wikimedia Commons, CC BY-SA 3.0; '
           'idle: Mercedes-Benz Black Series, Alfisti J (YouTube) via Wikimedia Commons, CC BY 3.0',
    'camaro': 'Chevrolet Camaro: biholao, Freesound, CC0; idle: Camaro Z28, Luciano\'s Classics (YouTube) via '
              'Wikimedia Commons, CC BY 3.0',
}


def load_file(fn):
    import imageio_ffmpeg
    raw = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'quiet', '-i', os.path.join(ROOT, 'cache', fn),
                          '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def points_for(rmax):
    p = list(range(1000, 2000, 200)) + list(range(2000, 4000, 250)) + list(range(4000, int(rmax) + 1, 350))
    return p


def build_engine(eid, cfg):
    tracks = json.load(open(os.path.join(ROOT, 'data', f'tracks_{eid}.json')))
    idle_file = IDLES[eid][0]
    segs = []
    for fn, segl in tracks.items():
        if fn == idle_file and eid != 'm5' and eid != 'f458':
            continue           # idle-only recording
        x = load_file(fn)
        for tr in segl:
            if len(tr) < 12:
                continue
            s = Segment(fn, x, tr)
            segs.append(s)
    # reference cycle: the ON frame closest to the median ON rpm
    cand = []
    for si, s in enumerate(segs):
        for j in range(0, len(s.x), int(0.02 * SR)):
            cand.append((si, j, s.rpm[j], classify(s.rpm[j], s.slope[j])))
    on = [c for c in cand if c[3] == 'ON']
    med = np.median([c[2] for c in on])
    si, j, _, _ = min(on, key=lambda c: abs(c[2] - med))
    ref = segs[si].angle_cycles(np.floor(segs[si].phi[j]), 4).mean(0)

    def local_offset(seg, i, ncyc=4):
        p0 = np.floor(seg.phi[i])
        if seg.phi[-1] - p0 < ncyc + 0.1:
            p0 = max(0, np.floor(seg.phi[-1] - ncyc - 0.1))
        return cycle_offset(seg.angle_cycles(p0, ncyc).mean(0), ref)

    rmax = max(c[2] for c in cand)
    loops, audio, pos = [], [], 0
    for layer in ('ON', 'OFF'):
        for P in points_for(rmax):
            pool = [c for c in cand if c[3] == layer and abs(np.log(c[2] / P)) < TOL]
            if layer == 'ON':
                pool += [c for c in cand if c[3] == 'CRUISE' and abs(np.log(c[2] / P)) < TOL / 2]
            # need room for the loop
            pool = [c for c in pool if c[1] > 0.1 * SR and len(segs[c[0]].x) - c[1] > 0.3 * SR]
            if not pool:
                continue
            si, j, r, _ = min(pool, key=lambda c: abs(np.log(c[2] / P)) - 0.002 * min(len(segs[c[0]].x) / SR, 10))
            s = segs[si]
            K = max(3, int(round(P / 120 * 0.5)))
            Nc = int(round(SR * 120 / P))
            off = local_offset(s, j)
            ph0 = np.floor(s.phi[j] - off - K / 2) + off
            if ph0 < 0:
                ph0 += np.ceil(-ph0)
            if ph0 + K + 1 > s.phi[-1]:
                ph0 = np.floor(s.phi[-1] - off - K - 1) + off
            if ph0 < 0:
                continue
            Kuse = int(min(K, np.floor(s.phi[-1] - ph0 - 1)))
            if Kuse < 2:
                continue
            grid = ph0 + np.arange((Kuse + 1) * Nc) / Nc
            idx = np.interp(grid, s.phi, np.arange(len(s.phi)))
            xu = resample_poly(s.x, 4, 1)
            y = np.interp(idx * 4, np.arange(len(xu)), xu)
            body, tail = y[:Kuse * Nc].copy(), y[Kuse * Nc:]
            fade = np.sin(np.linspace(0, np.pi / 2, Nc)) ** 2
            body[:Nc] = body[:Nc] * fade + tail[:Nc] * (1 - fade)
            body *= norm_gain(body, layer)
            loops.append(dict(layer=layer, rpm=P, cycles=Kuse, nc=Nc, start=pos, length=len(body),
                              src=s.fid, srcRpm=round(float(r)), t=round(s.t0 + j / SR, 2)))
            audio.append(body)
            pos += len(body)
    y = np.concatenate(audio)
    y *= min(1, 0.97 / np.abs(y).max())
    write_wav(os.path.join(OUT, f'bank_{eid}.wav'), y)
    on_pts = [l['rpm'] for l in loops if l['layer'] == 'ON']
    off_pts = [l['rpm'] for l in loops if l['layer'] == 'OFF']
    print(eid, f'{len(y) / SR:.1f}s', 'ON', on_pts, 'OFF', off_pts)

    # idle
    fn, t0, t1 = IDLES[eid]
    xi = load_file(fn)[int(t0 * SR):int(t1 * SR)]
    xi = sosfiltfilt(butter(2, 25, 'highpass', fs=SR, output='sos'), xi)
    xi, tones = notch_tones(xi)
    yi, corr = seamless_loop(xi, 0.8)
    yi *= 10 ** (-20 / 20) / np.sqrt(np.mean(yi ** 2))
    yi *= min(1, 0.97 / np.abs(yi).max())
    write_wav(os.path.join(OUT, f'idle_{eid}.wav'), yi)
    itr = tracks[fn]
    irpm = [r for seg in itr for t, r in seg if t0 <= t <= t1]
    idle_rpm = int(round(np.median(irpm) / 5) * 5)
    print('  idle', fn, f'{len(yi) / SR:.1f}s', idle_rpm, 'rpm', 'notched', tones)
    return dict(id=eid, name=cfg['name'], pulses=PULSES[cfg['kind']], bank=f'bank_{eid}.wav', loops=loops,
                idle=dict(id=f'own_{eid}', name=f"{cfg['name']} (own idle)", rpm=idle_rpm, file=f'idle_{eid}.wav',
                          seconds=round(len(yi) / SR, 2)),
                credit=CREDITS[eid])


def main():
    cfgs = json.load(open(os.path.join(ROOT, 'engines.json')))
    out = []
    a = json.load(open(os.path.join(OUT, 'bankA.json')))
    out.append(dict(id='gt500', name='Ford Mustang GT500 V8', pulses=8, bank='bankA.wav', loops=a['loops'],
                    idle=None, credit='Ford Mustang GT500: VacekH, Freesound, CC0', gain=1.0))
    for eid, cfg in cfgs.items():
        out.append({**build_engine(eid, cfg), 'gain': GAIN.get(eid, 1.0)})
    json.dump(dict(sr=SR, engines=out), open(os.path.join(OUT, 'engines.json'), 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()
