// V8 engine sound renderer (AudioWorklet). Plays real recordings only; no synthesis.
//
// One crank phase `phi` (engine cycles of 720 deg) advances at rpm / 120 cycles per second,
// so everything stays phase-locked to the target RPM.
//
//  Loop bank:  constant-RPM loops cut from the recordings (on-load and off-load layers),
//              each an integer number of cycles and phase-aligned to one reference cycle.
//              The two loops bracketing the RPM are read at the shared phase and
//              crossfaded; load crossfades the on/off layers.
//  Idle:       below ~1.4x idle RPM and with no throttle, a long seamless loop of a real
//              steady idle (the chosen idle variant) plays untouched, and crossfades into
//              the loop bank as revs or throttle rise.

const TAU_RPM = 0.010;   // s, smoothing of RPM steps arriving at ~60 Hz
const TAU_LOAD = 0.035;
const TAU_GAIN = 0.05;

class V8Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rpmT = 850; this.rpm = 850;
    this.loadT = 0; this.load = 0;
    this.gainT = 0; this.gain = 0;
    this.phi = 0;
    this.A = null; this.I = null;
    this.idlePos = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'bankA') this.A = prepA(m);
    else if (m.type === 'idle') { this.I = m; this.idlePos = 0; }
    else if (m.type === 'state') {
      this.rpmT = m.rpm; this.loadT = m.load;
      if (m.gain !== undefined) this.gainT = m.gain;
    }
  }

  process(_in, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const kR = 1 - Math.exp(-1 / (sampleRate * TAU_RPM));
    const kL = 1 - Math.exp(-1 / (sampleRate * TAU_LOAD));
    const kG = 1 - Math.exp(-1 / (sampleRate * TAU_GAIN));
    for (let i = 0; i < n; i++) {
      this.rpm += (this.rpmT - this.rpm) * kR;
      this.load += (this.loadT - this.load) * kL;
      this.gain += (this.gainT - this.gain) * kG;
      this.phi += this.rpm / (120 * sampleRate);
      // idle <-> engine crossfade (equal power)
      let mix = 1;
      if (this.I) {
        const ir = this.I.rpm;
        mix = Math.max(smooth(ir * 1.06, ir * 1.45, this.rpm), smooth(0.16, 0.42, this.load));
      }
      let s = 0;
      if (mix > 0.001 && this.A) s = Math.sin(mix * Math.PI / 2) * this.sampleA();
      if (mix < 0.999) s += Math.cos(mix * Math.PI / 2) * this.sampleIdle();
      out[i] = s * this.gain;
    }
    return true;
  }

  // ---------------------------------------------------------------- idle
  sampleIdle() {
    const I = this.I, d = I.data, n = I.length;
    const i = this.idlePos | 0, f = this.idlePos - i;
    const a = d[i], b = d[i + 1 < n ? i + 1 : 0];
    this.idlePos += (this.rpm / I.rpm) * (I.sr / sampleRate);
    if (this.idlePos >= n) this.idlePos -= n;
    return a + (b - a) * f;
  }

  // ---------------------------------------------------------------- loop bank
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

registerProcessor('v8-engine', V8Engine);
