// V8 engine sound renderer (AudioWorklet). Plays real recordings only; no synthesis.
//
// Both modes share one crank phase `phi` (engine cycles of 720 deg) that advances at
// rpm / 120 cycles per second, so everything stays phase-locked to the target RPM.
//
//  A "loop bank":  constant-RPM loops cut from the recordings (on-load and off-load layers),
//                  each an integer number of cycles and phase-aligned to one reference cycle.
//                  The two loops bracketing the RPM are read at the shared phase and
//                  crossfaded; load crossfades the on/off layers.
//  B "granular":   the continuous recordings with a per-frame RPM/load map. Every engine
//                  cycle a 2-cycle Hann grain starts. It continues the previous grain's
//                  place in the recording while that still matches the target RPM/load, so
//                  matching stretches play back untouched; otherwise it jumps to the
//                  best-matching frame. Each grain is resampled so its pitch is exactly the
//                  target RPM.

const TAU_RPM = 0.010;   // s, smoothing of RPM steps arriving at ~60 Hz
const TAU_LOAD = 0.035;
const TAU_GAIN = 0.05;

class V8Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'A';
    this.rpmT = 850; this.rpm = 850;
    this.loadT = 0; this.load = 0;
    this.gainT = 0; this.gain = 0;
    this.rate = 0;            // rpm/s of the target, used by B to prefer matching slope
    this.phi = 0;
    this.cycle = 0;
    this.A = null; this.B = null;
    this.grains = [];
    this.lastGrain = null;
    this.stats = { jumps: 0, conts: 0 };
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'bankA') this.A = prepA(m);
    else if (m.type === 'bankB') this.B = prepB(m);
    else if (m.type === 'state') {
      this.rpmT = m.rpm; this.loadT = m.load; this.rate = m.rate || 0;
      if (m.gain !== undefined) this.gainT = m.gain;
      if (m.mode && m.mode !== this.mode) { this.mode = m.mode; this.grains = []; this.lastGrain = null; }
    } else if (m.type === 'stats') {
      this.port.postMessage({ type: 'stats', ...this.stats, grains: this.grains.length });
    }
  }

  process(_in, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const kR = 1 - Math.exp(-1 / (sampleRate * TAU_RPM));
    const kL = 1 - Math.exp(-1 / (sampleRate * TAU_LOAD));
    const kG = 1 - Math.exp(-1 / (sampleRate * TAU_GAIN));
    const useA = this.mode === 'A' && this.A;
    const useB = this.mode === 'B' && this.B;
    for (let i = 0; i < n; i++) {
      this.rpm += (this.rpmT - this.rpm) * kR;
      this.load += (this.loadT - this.load) * kL;
      this.gain += (this.gainT - this.gain) * kG;
      this.phi += this.rpm / (120 * sampleRate);
      let s = 0;
      if (useA) s = this.sampleA();
      else if (useB) s = this.sampleB();
      out[i] = s * this.gain;
    }
    return true;
  }

  // ---------------------------------------------------------------- A
  sampleA() {
    const A = this.A, rpm = this.rpm;
    const pts = A.points;
    let lo = 0, hi = 0, x = 0;
    if (rpm <= pts[0]) { lo = hi = 0; }
    else if (rpm >= pts[pts.length - 1]) { lo = hi = pts.length - 1; }
    else {
      while (hi < pts.length - 1 && pts[hi] <= rpm) hi++;
      lo = hi - 1;
      x = (rpm - pts[lo]) / (pts[hi] - pts[lo]);
    }
    const g1 = Math.cos(x * Math.PI / 2), g2 = Math.sin(x * Math.PI / 2);
    const w = smooth(0.04, 0.75, this.load);
    const gOn = Math.sin(w * Math.PI / 2), gOff = Math.cos(w * Math.PI / 2);
    const d = A.data, phi = this.phi;
    let on = g1 * readLoop(d, A.on[lo], phi);
    let off = g1 * readLoop(d, A.off[lo], phi);
    if (hi !== lo) {
      on += g2 * readLoop(d, A.on[hi], phi);
      off += g2 * readLoop(d, A.off[hi], phi);
    }
    return gOn * on + gOff * off;
  }

  // ---------------------------------------------------------------- B
  sampleB() {
    const B = this.B;
    const c = Math.floor(this.phi);
    if (c !== this.cycle || this.grains.length === 0) { this.cycle = c; this.spawnGrain(); }
    let s = 0;
    const ratio = B.sr / sampleRate;
    for (let k = this.grains.length - 1; k >= 0; k--) {
      const g = this.grains[k];
      const u = (this.phi - g.phi0) / 2;
      if (u >= 1 || g.pos >= g.end) { this.grains.splice(k, 1); if (g === this.lastGrain) this.lastGrain = null; continue; }
      const w = Math.sin(Math.PI * u);
      const i = g.pos | 0, f = g.pos - i;
      const a = B.data[i], b = B.data[i + 1];
      s += w * w * (a + (b - a) * f);
      g.pos += (this.rpm / rpmAt(B, g.seg, g.pos)) * ratio;
    }
    return s;
  }

  spawnGrain() {
    const B = this.B, R = this.rpm, L = this.load, slopeT = this.rate;
    const prev = this.lastGrain;
    let seg = -1, pos = 0;
    if (prev) {
      const rs = rpmAt(B, prev.seg, prev.pos);
      const fi = frameAt(B, prev.seg, prev.pos);
      const sg = B.segs[prev.seg];
      const room = sg.end - prev.pos > 2.4 * (120 / rs) * B.sr;
      const ld = sg.load[fi], sl = sg.slope[fi];
      if (room && Math.abs(Math.log(rs / R)) < 0.045 && Math.abs(ld - L) < 0.45 &&
          !(slopeT > 350 && sl < -150) && !(slopeT < -350 && sl > 150)) {
        seg = prev.seg; pos = prev.pos;
        this.stats.conts++;
      }
    }
    if (seg < 0) {
      const j = this.search(R, L, slopeT);
      if (j < 0) return;
      const F = B.flat;
      seg = F.seg[j];
      const rs = F.rpm[j], ph = F.phi[j];
      pos = F.pos[j] + (Math.ceil(ph) - ph) * (120 / rs) * B.sr;   // next aligned cycle start
      this.stats.jumps++;
    }
    const g = { seg, pos, phi0: this.phi, end: B.segs[seg].end - 2 };
    this.grains.push(g);
    this.lastGrain = g;
    if (this.grains.length > 4) this.grains.shift();
  }

  search(R, L, slopeT) {
    const F = this.B.flat, n = F.rpm.length;
    const lnR = Math.log(R);
    let best = -1, bc = 1e9;
    for (let j = 0; j < n; j++) {
      const rs = F.rpm[j];
      const cyc = (120 / rs) * this.B.sr;
      if (F.room[j] < 3.2 * cyc) continue;
      let cost = 10 * Math.abs(Math.log(rs) - lnR) + 1.6 * Math.abs(F.load[j] - L) + F.pref[j];
      cost += Math.min(Math.abs(F.slope[j] - slopeT) / 2500, 0.5);
      cost += Math.random() * 0.04;
      if (cost < bc) { bc = cost; best = j; }
    }
    return best;
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function readLoop(d, L, phi) {
  const p = (phi % L.cycles) * L.nc;
  const i = p | 0, f = p - i;
  const a = d[L.start + i];
  const b = d[L.start + (i + 1 < L.length ? i + 1 : 0)];
  return a + (b - a) * f;
}

function prepA(m) {
  const on = m.loops.filter((l) => l.layer === 'ON').sort((a, b) => a.rpm - b.rpm);
  const off = m.loops.filter((l) => l.layer === 'OFF').sort((a, b) => a.rpm - b.rpm);
  return { data: m.data, on, off, points: on.map((l) => l.rpm) };
}

function prepB(m) {
  const FR = Math.round(m.frame * m.sr);
  const segs = [];
  const flat = { seg: [], pos: [], rpm: [], slope: [], load: [], phi: [], pref: [], room: [] };
  m.segments.forEach((s, si) => {
    const nf = s.frames.length;
    const sg = {
      start: s.start, end: s.start + s.length, fl: FR,
      rpm: new Float32Array(nf), slope: new Float32Array(nf), load: new Float32Array(nf), phi: new Float64Array(nf),
    };
    s.frames.forEach((f, k) => {
      sg.rpm[k] = f[0]; sg.slope[k] = f[1]; sg.load[k] = f[2]; sg.phi[k] = f[3];
      flat.seg.push(si); flat.pos.push(s.start + k * FR); flat.rpm.push(f[0]); flat.slope.push(f[1]);
      flat.load.push(f[2]); flat.phi.push(f[3]); flat.pref.push(s.pref); flat.room.push(s.length - k * FR);
    });
    segs.push(sg);
  });
  for (const k of Object.keys(flat)) flat[k] = Float64Array.from(flat[k]);
  return { data: m.data, sr: m.sr, segs, flat };
}

function frameAt(B, si, pos) {
  const s = B.segs[si];
  const f = Math.min(s.rpm.length - 1, Math.max(0, Math.round((pos - s.start) / s.fl)));
  return f;
}

function rpmAt(B, si, pos) {
  const s = B.segs[si];
  const x = (pos - s.start) / s.fl;
  const i = Math.min(s.rpm.length - 2, Math.max(0, x | 0));
  const f = Math.min(1, Math.max(0, x - i));
  return s.rpm[i] + (s.rpm[i + 1] - s.rpm[i]) * f;
}

registerProcessor('v8-engine', V8Engine);
