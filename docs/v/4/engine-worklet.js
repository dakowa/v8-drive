// Engine sound renderer (AudioWorklet). Plays real recordings only; no synthesis.
//
// One crank phase `phi` (engine cycles of 720 deg) advances at the sound RPM (RPM x pitch),
// so the loop bank stays phase-locked to it.
//
//  Loop bank:  constant-RPM loops cut from the recordings (on-load and off-load layers),
//              each an integer number of cycles and phase-aligned to one reference cycle.
//              The two loops bracketing the RPM are read at the shared phase and
//              crossfaded; load crossfades the on/off layers.
//  Pulses:     where the nearest loop is more than ~15% away from the target (above or below
//              what was recorded, or a high pitch setting), the loop isn't sped up. Its firing
//              pulses are cut out (2 pulses long, Hann) and re-spaced at the target firing
//              rate, so the exhaust resonances stay where they are, as on a real engine.
//  Idle:       below ~1.4x idle RPM and with no throttle, a long seamless loop of a real
//              steady idle plays at the true RPM (pitch doesn't apply), and crossfades into
//              the loop bank as revs or throttle rise.

const TAU_RPM = 0.010;   // s, smoothing of RPM steps arriving at ~60 Hz
const TAU_LOAD = 0.035;
const TAU_GAIN = 0.05;
const RESAMPLE_MAX = 0.15;   // |ln(target/loop rpm)| up to which plain resampling is used
const PULSE_FULL = 0.25;     // ...and from which only pulse re-spacing is used

class EngineSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rpmT = 850; this.rpm = 850;
    this.pitchT = 1; this.pitch = 1;
    this.loadT = 0; this.load = 0;
    this.gainT = 0; this.gain = 0;
    this.bankMinT = 0; this.bankMin = 0;
    this.phi = 0;
    this.bank = null; this.I = null;
    this.idlePos = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'bank') this.bank = prepBank(m);
    else if (m.type === 'idle') { this.I = m; this.idlePos = 0; }
    else if (m.type === 'state') {
      this.rpmT = m.rpm; this.loadT = m.load;
      if (m.pitch !== undefined) this.pitchT = m.pitch;
      if (m.bankMin !== undefined) this.bankMinT = m.bankMin;
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
      this.pitch += (this.pitchT - this.pitch) * kL;
      this.load += (this.loadT - this.load) * kL;
      this.gain += (this.gainT - this.gain) * kG;
      this.bankMin += (this.bankMinT - this.bankMin) * kG;
      const rpmS = this.rpm * this.pitch;
      this.phi += rpmS / (120 * sampleRate);
      // idle <-> engine crossfade (equal power), judged on the true RPM
      let mix = 1;
      if (this.I) {
        const ir = this.I.rpm;
        mix = Math.max(smooth(ir * 1.06, ir * 1.45, this.rpm), smooth(0.16, 0.42, this.load), this.bankMin);
      }
      let s = 0;
      if (mix > 0.001 && this.bank) s = Math.sin(mix * Math.PI / 2) * this.sampleBank(rpmS);
      if (mix < 0.999 && this.I) s += Math.cos(mix * Math.PI / 2) * this.sampleIdle();
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
  sampleBank(R) {
    const B = this.bank;
    const w = smooth(0.04, 0.75, this.load);
    const gOn = Math.sin(w * Math.PI / 2), gOff = Math.cos(w * Math.PI / 2);
    let s = 0;
    if (gOn > 0.001) s += gOn * this.layer(B.on, R);
    if (gOff > 0.001) s += gOff * this.layer(B.off.length ? B.off : B.on, R);
    return s;
  }

  layer(list, R) {
    let lo = 0, hi = 0, x = 0;
    const last = list.length - 1;
    if (R <= list[0].rpm) { lo = hi = 0; }
    else if (R >= list[last].rpm) { lo = hi = last; }
    else {
      while (hi < last && list[hi].rpm <= R) hi++;
      lo = hi - 1;
      x = (R - list[lo].rpm) / (list[hi].rpm - list[lo].rpm);
    }
    // two loops far apart (a gap in the recording): lean on the nearer one
    if (hi !== lo && Math.log(list[hi].rpm / list[lo].rpm) > 2 * RESAMPLE_MAX) x = smooth(0.35, 0.65, x);
    const g1 = Math.cos(x * Math.PI / 2), g2 = Math.sin(x * Math.PI / 2);
    let s = g1 * this.read(list[lo], R);
    if (hi !== lo && g2 > 0.001) s += g2 * this.read(list[hi], R);
    return s;
  }

  read(L, R) {
    const dev = Math.abs(Math.log(R / L.rpm));
    if (dev <= RESAMPLE_MAX) return readLoop(this.bank.data, L, this.phi);
    const t = smooth(RESAMPLE_MAX, PULSE_FULL, dev);
    const p = this.readPulses(L);
    return t >= 1 ? p : (1 - t) * readLoop(this.bank.data, L, this.phi) + t * p;
  }

  // Pulse re-spacing (TD-PSOLA on firing pulses): each output firing pulse plays a 2-pulse Hann
  // grain of the loop at native speed.
  readPulses(L) {
    const z = this.bank.pulses, d = this.bank.data;
    const Lp = L.nc / z;                       // source samples per firing pulse
    const j = Math.floor(this.phi * z);        // global output pulse index
    if (L.lastJ !== j) {
      L.lastJ = j;
      const n = L.cycles * z;
      const k = ((j % n) + n) % n;
      L.grains.push({ c: k * Lp, e: 0 });
      if (L.grains.length > 8) L.grains.shift();
    }
    const step = this.bank.sr / sampleRate;
    let s = 0, ws = 0;
    for (let g = L.grains.length - 1; g >= 0; g--) {
      const G = L.grains[g];
      if (G.e >= 2 * Lp) { L.grains.splice(g, 1); continue; }
      const w = 0.5 - 0.5 * Math.cos(Math.PI * G.e / Lp);
      let p = G.c - Lp + G.e;
      p = ((p % L.length) + L.length) % L.length;
      const i = p | 0, f = p - i;
      const a = d[L.start + i], b = d[L.start + (i + 1 < L.length ? i + 1 : 0)];
      s += w * (a + (b - a) * f);
      ws += w;
      G.e += step;
    }
    return ws > 1 ? s / ws : s;
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

function prepBank(m) {
  const mk = (layer) => m.loops.filter((l) => l.layer === layer).sort((a, b) => a.rpm - b.rpm)
    .map((l) => ({ ...l, grains: [], lastJ: -1 }));
  return { data: m.data, sr: m.sr, pulses: m.pulses || 8, on: mk('ON'), off: mk('OFF') };
}

registerProcessor('v8-engine', EngineSound);
