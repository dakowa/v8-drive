// Engine sound renderer (AudioWorklet). Plays real recordings only; no synthesis.
//
// One crank phase `phi` (engine cycles of 720 deg) advances at the sound RPM, so the loop bank
// stays phase-locked to it.
//
//  Loop bank:  constant-RPM loops cut from the recordings (on-load and off-load layers),
//              each an integer number of cycles and phase-aligned to one reference cycle.
//              The two loops bracketing the sound RPM are read at the shared phase and
//              crossfaded; load crossfades the on/off layers.
//  Idle:       at idle and while crawling, a long seamless loop of a real steady idle plays.
//              Idle and loop bank switch with hysteresis (on engine RPM and load) and a short
//              timed crossfade, so the sound is always one or the other, never a lingering blend.
//
// Engine pitch: sound RPM = RPM x pitch, with one limit: nothing plays faster than it did at
// pitch 1.10, the highest that sounded natural. The idle stays at 1.10 x its recorded speed at
// most, and at the top, where the recordings end (~4300 rpm), higher pitch only rises gently.

const TAU_RPM = 0.010;   // s, smoothing of RPM steps arriving at ~60 Hz
const TAU_LOAD = 0.035;
const TAU_GAIN = 0.05;
const PITCH_SAFE = 1.10;
const TOP_KNEE = 3700, TOP_CEIL = 4300;   // sound RPM where higher pitch starts to flatten out
// idle -> engine above 1.40 x idle RPM or load 0.30; back below 1.30 x idle RPM and load 0.20
// (standing and crawling the drivetrain holds the engine at 1.16-1.26 x idle RPM)
const UP_R = 1.40, UP_LOAD = 0.30, DOWN_R = 1.30, DOWN_LOAD = 0.20;
const FADE_UP = 0.05, FADE_DOWN = 0.30;   // s (engine in fast so pulling away bites at once)

class EngineSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rpmT = 850; this.rpm = 850;
    this.pitchT = 1; this.pitch = 1; this.pitchSet = false;
    this.loadT = 0; this.load = 0;
    this.gainT = 0; this.gain = 0;
    this.toBank = false; this.mix = 0;
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
      if (m.pitch !== undefined) {
        this.pitchT = m.pitch;
        if (!this.pitchSet) { this.pitch = m.pitch; this.pitchSet = true; }
      }
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
    // idle <-> engine: switched once per block on the smoothed RPM and load
    if (this.I) {
      const r = this.rpm / this.I.rpm;
      if (!this.toBank && (r > UP_R || this.load > UP_LOAD)) this.toBank = true;
      else if (this.toBank && r < DOWN_R && this.load < DOWN_LOAD) this.toBank = false;
    } else this.toBank = true;
    const dMix = this.toBank ? 1 / (FADE_UP * sampleRate) : -1 / (FADE_DOWN * sampleRate);
    for (let i = 0; i < n; i++) {
      this.rpm += (this.rpmT - this.rpm) * kR;
      this.pitch += (this.pitchT - this.pitch) * kL;
      this.load += (this.loadT - this.load) * kL;
      this.gain += (this.gainT - this.gain) * kG;
      this.mix = Math.min(1, Math.max(0, this.mix + dMix));
      const p = this.pitch, mix = this.mix;
      const sBank = bankRpm(this.rpm, p);
      this.phi += sBank / (120 * sampleRate);
      let s = 0;
      if (mix > 0.001 && this.bank) s = Math.sin(mix * Math.PI / 2) * this.sampleBank(sBank);
      if (mix < 0.999 && this.I) s += Math.cos(mix * Math.PI / 2) * this.sampleIdle(Math.min(this.rpm * p, this.I.rpm * PITCH_SAFE));
      out[i] = s * this.gain;
    }
    return true;
  }

  // ---------------------------------------------------------------- idle
  sampleIdle(S) {
    const I = this.I, d = I.data, n = I.length;
    const i = this.idlePos | 0, f = this.idlePos - i;
    const a = d[i], b = d[i + 1 < n ? i + 1 : 0];
    this.idlePos += (S / I.rpm) * (I.sr / sampleRate);
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
    if (gOff > 0.001) s += gOff * this.layer(B.off, R);
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
    const g1 = Math.cos(x * Math.PI / 2), g2 = Math.sin(x * Math.PI / 2);
    const d = this.bank.data;
    let s = g1 * readLoop(d, list[lo], this.phi);
    if (hi !== lo) s += g2 * readLoop(d, list[hi], this.phi);
    return s;
  }
}

// Sound RPM of the loop bank. Up to pitch 1.10 it is RPM x pitch. Above that the top is
// soft-limited to TOP_CEIL (the recordings end there), but never below RPM x 1.10.
function bankRpm(rpm, p) {
  const s = rpm * p;
  if (p <= PITCH_SAFE || s <= TOP_KNEE) return s;
  const w = TOP_CEIL - TOP_KNEE;
  return Math.max(rpm * PITCH_SAFE, TOP_KNEE + w * Math.tanh((s - TOP_KNEE) / w));
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
  const mk = (layer) => m.loops.filter((l) => l.layer === layer).sort((a, b) => a.rpm - b.rpm);
  return { data: m.data, sr: m.sr, on: mk('ON'), off: mk('OFF') };
}

registerProcessor('v8-engine', EngineSound);
