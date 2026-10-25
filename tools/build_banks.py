"""Build the two V8 sample banks used by the web app from real recordings.

Sources: Ford Mustang GT500 recordings by VacekH on Freesound (CC0), see sources.json.
RPM tracks (tools/data/tracks.json) were measured from the recordings' firing-order
harmonics (firing frequency = rpm / 15 for a V8) with a Viterbi comb tracker.

Outputs (docs/audio/):
  bankA.wav + bankA.json  -- approach A: phase-aligned constant-RPM loops (on/off load)
  bankB.wav + bankB.json  -- approach B: the continuous recordings + per-frame RPM/load map
"""
import json, os, subprocess, sys
import numpy as np
from scipy.signal import butter, sosfiltfilt, resample_poly, savgol_filter

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', 'docs', 'audio')
SR = 32000
CYC = 256                      # angle-domain samples per engine cycle (720 deg) for alignment
FRAME = 0.010                  # bank B metadata frame (s)

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    FFMPEG = 'ffmpeg'


def load(fid):
    raw = subprocess.run([FFMPEG, '-v', 'quiet', '-i', os.path.join(ROOT, 'cache', f'{fid}.ogg'),
                          '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


class Segment:
    """A tracked stretch of one recording: audio, per-sample rpm and crank phase."""

    def __init__(self, fid, x, track):
        tr = np.array(track)
        t, rpm = tr[:, 0], tr[:, 1]
        if len(rpm) > 9:
            rpm = savgol_filter(rpm, 9, 2)
        self.fid, self.t0, self.t1 = fid, t[0], t[-1]
        a, b = int(round(t[0] * SR)), int(round(t[-1] * SR))
        self.x = x[a:b].copy()
        ts = (np.arange(b - a) + a) / SR
        self.rpm = np.interp(ts, t, rpm)
        self.phi = np.concatenate([[0], np.cumsum(self.rpm / 120 / SR)[:-1]])  # cycles
        self.lp = sosfiltfilt(butter(4, 1800, fs=SR, output='sos'), self.x)
        # slope (rpm/s) smoothed over ~0.3 s
        k = int(0.3 * SR)
        r = self.rpm
        self.slope = np.gradient(np.convolve(r, np.ones(k) / k, 'same')) * SR
        self.slope[:k // 2] = self.slope[k // 2]
        self.slope[-k // 2:] = self.slope[-k // 2 - 1]

    def angle_cycles(self, phi0, n):
        """Low-passed waveform resampled to CYC samples per cycle for n cycles from phase phi0."""
        grid = phi0 + np.arange(n * CYC) / CYC
        idx = np.interp(grid, self.phi, np.arange(len(self.phi)))
        return np.interp(idx, np.arange(len(self.lp)), self.lp).reshape(n, CYC)


def classify(rpm, slope):
    if rpm < 1080 and abs(slope) < 250:
        return 'IDLE'
    if slope > 70:
        return 'ON'
    if slope < -70:
        return 'OFF'
    return 'CRUISE'


LOAD = {'ON': 1.0, 'CRUISE': 0.4, 'OFF': 0.0, 'IDLE': 0.15}
RMS_TARGET = {'ON': -15.0, 'CRUISE': -18.0, 'OFF': -21.0, 'IDLE': -21.0}  # dBFS


def cycle_offset(shape, ref):
    """Fraction of a cycle by which `shape` lags `ref` (circular cross-correlation)."""
    s = (shape - shape.mean()) / (shape.std() + 1e-9)
    r = (ref - ref.mean()) / (ref.std() + 1e-9)
    c = np.fft.irfft(np.fft.rfft(s) * np.conj(np.fft.rfft(r)), n=CYC)
    return int(np.argmax(c)) / CYC


def norm_gain(x, cls):
    rms = np.sqrt(np.mean(x ** 2) + 1e-12)
    return 10 ** (RMS_TARGET[cls] / 20) / rms


def main():
    src = json.load(open(os.path.join(ROOT, 'data', 'tracks.json')))
    segs = []
    for fid, tracks in src.items():
        x = load(fid)
        for tr in tracks:
            segs.append(Segment(fid, x, tr))
    print('segments', [(s.fid, round(s.t0, 2), round(s.t1, 2)) for s in segs])

    # Reference cycle shape: 205511 second-gear pull around 3000 rpm.
    ref_seg = segs[0]
    i = int((9.5 - ref_seg.t0) * SR)
    ref = ref_seg.angle_cycles(np.floor(ref_seg.phi[i]), 6).mean(0)

    def local_offset(seg, i, ncyc=4):
        p0 = np.floor(seg.phi[i])
        if seg.phi[-1] - p0 < ncyc + 0.1:
            p0 = max(0, np.floor(seg.phi[-1] - ncyc - 0.1))
        return cycle_offset(seg.angle_cycles(p0, ncyc).mean(0), ref)

    os.makedirs(OUT, exist_ok=True)
    build_b(segs, local_offset)
    build_a(segs, local_offset)


# ---------------------------------------------------------------- bank B

def build_b(segs, local_offset):
    audio, meta = [], []
    pos = 0
    for si, s in enumerate(segs):
        n = len(s.x)
        hop = int(FRAME * SR)
        frames = []
        # per-frame class -> slowly varying normalisation gain toward class loudness
        cls_per = [classify(s.rpm[j], s.slope[j]) for j in range(0, n, hop)]
        win = min(int(1.0 * SR), n - 1)
        env = np.sqrt(np.convolve(s.x ** 2, np.ones(win) / win, 'same') + 1e-10)
        tgt = np.array([10 ** (RMS_TARGET[c] / 20) for c in cls_per])
        tgt = np.convolve(np.repeat(tgt, hop)[:n], np.ones(win) / win, 'same')
        y = s.x * np.clip(tgt / env, 0.1, 8)
        for k, j in enumerate(range(0, n, hop)):
            c = cls_per[k]
            off = local_offset(s, j)
            frames.append([round(s.rpm[j], 1), round(float(s.slope[j]), 0), LOAD[c],
                           round(float(s.phi[j] - off), 4)])
        meta.append(dict(fid=s.fid, start=pos, length=n, t0=round(s.t0, 3),
                         pref=0.0 if s.fid == '205511' else (0.4 if s.fid == '205508' else 0.15),
                         frames=frames))
        audio.append(y)
        pos += n
    y = np.concatenate(audio)
    peak = np.abs(y).max()
    if peak > 0.98:
        y *= 0.98 / peak
        print('B scaled by', 0.98 / peak)
    write_wav(os.path.join(OUT, 'bankB.wav'), y)
    json.dump(dict(sr=SR, frame=FRAME, segments=meta), open(os.path.join(OUT, 'bankB.json'), 'w'),
              separators=(',', ':'))
    print('bank B', round(len(y) / SR, 1), 's')


# ---------------------------------------------------------------- bank A

POINTS = [900, 1100, 1300, 1500, 1700, 1900, 2100, 2350, 2600, 2850, 3100, 3350, 3600, 3850, 4100, 4400]


def build_a(segs, local_offset):
    # candidate samples: (seg, index, rpm, class)
    cand = []
    for si, s in enumerate(segs):
        for j in range(0, len(s.x), int(0.02 * SR)):
            cand.append((si, j, s.rpm[j], classify(s.rpm[j], s.slope[j])))
    loops, audio, pos = [], [], 0
    for layer, classes in (('ON', ('ON',)), ('OFF', ('OFF',))):
        for P in POINTS:
            want = ('IDLE',) if P < 1000 else classes
            pool = [c for c in cand if c[3] in want]
            if layer == 'ON' and P >= 1000:
                pool += [c for c in cand if c[3] == 'CRUISE' and abs(np.log(c[2] / P)) < 0.04]
            best = None
            for si, j, r, c in pool:
                s = segs[si]
                cost = abs(np.log(r / P)) * 10 + (0.0 if s.fid == '205511' else 0.25)
                # prefer enough room around the point
                if j < 0.25 * SR or len(s.x) - j < 0.6 * SR:
                    cost += 1.0
                if best is None or cost < best[0]:
                    best = (cost, si, j)
            _, si, j = best
            s = segs[si]
            K = max(4, int(round(P / 120 * 0.75)))          # ~0.75 s of engine cycles
            Nc = int(round(SR * 120 / P))                  # output samples per cycle at P
            off = local_offset(s, j)
            ph0 = np.floor(s.phi[j] - off - K / 2) + off      # aligned integer phase start
            ph0 = max(ph0, off if off < s.phi[-1] else 0)
            if ph0 + K + 1 > s.phi[-1]:
                ph0 = np.floor(s.phi[-1] - off - K - 1) + off
            if ph0 < 0:
                ph0 += np.ceil(-ph0)
            Kuse = int(min(K, np.floor(s.phi[-1] - ph0 - 1)))
            grid = ph0 + np.arange((Kuse + 1) * Nc) / Nc
            idx = np.interp(grid, s.phi, np.arange(len(s.phi)))
            up = 4
            xu = resample_poly(s.x, up, 1)
            y = np.interp(idx * up, np.arange(len(xu)), xu)
            # seamless loop: crossfade the extra cycle into the first one
            body, tail = y[:Kuse * Nc].copy(), y[Kuse * Nc:]
            fade = np.sin(np.linspace(0, np.pi / 2, Nc)) ** 2
            body[:Nc] = body[:Nc] * fade + tail[:Nc] * (1 - fade)
            cls = 'IDLE' if P < 1000 else layer
            body *= norm_gain(body, cls)
            loops.append(dict(layer=layer, rpm=P, cycles=Kuse, nc=Nc, start=pos, length=len(body),
                              src=s.fid, srcRpm=round(float(s.rpm[j]), 0), t=round(s.t0 + j / SR, 2)))
            audio.append(body)
            pos += len(body)
            print(f'A {layer:3s} {P:5d}  src {s.fid} t={s.t0 + j / SR:6.2f} rpm={s.rpm[j]:6.0f} K={Kuse}')
    y = np.concatenate(audio)
    peak = np.abs(y).max()
    if peak > 0.98:
        y *= 0.98 / peak
        print('A scaled by', 0.98 / peak)
    write_wav(os.path.join(OUT, 'bankA.wav'), y)
    json.dump(dict(sr=SR, loops=loops), open(os.path.join(OUT, 'bankA.json'), 'w'), separators=(',', ':'))
    print('bank A', round(len(y) / SR, 1), 's')


def write_wav(path, y):
    import wave
    d = (np.clip(y, -1, 1) * 32767).astype('<i2').tobytes()
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(d)


if __name__ == '__main__':
    main()
