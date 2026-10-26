// Engine sound renderer (AudioWorklet). Plays real recordings only; no synthesis.
//
// One crank phase `phi` (engine cycles of 720 deg) advances at the sound RPM, so the loop bank
// stays phase-locked to it.
//
//  Loop bank:  constant-RPM loops cut from the recordings (on-load and off-load layers),
//              each an integer number of cycles and phase-aligned to one reference cycle.
//              The two loops bracketing the sound RPM are read at the shared phase and
//              crossfaded; load crossfades the on/off layers.
//  Idle:       below ~1.4x idle RPM and with no throttle, a long seamless loop of a real
//              steady idle plays, and crossfades into the loop bank as revs or throttle rise.
//
// Engine pitch (A/B):
//  A  as v3: sound RPM = RPM x pitch for everything (idle playback rate, idle/engine
//     crossfade and loop choice).
//  B  same as A up to pitch 1.10 and 5000 rpm. Above that no recording is sped up beyond what
//     sounded natural: the idle stays at its 1.10 pitch and the engine sound rises to the full
//     pitch as the idle fades out; above 5000 sound RPM (past the top recorded loop, 4400) the
//     sound keeps rising, but at 40% of the rate.

const TAU_RPM = 0.010;   // s, smoothing of RPM steps arriving at ~60 Hz
const TAU_LOAD = 0.035;
const TAU_GAIN = 0.05;
const IDLE_PITCH_MAX = 1.10;   // B
const TOP_KNEE = 5000, TOP_SLOPE = 0.4;   // B

class EngineSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rpmT = 850; this.rpm = 850;
    this.pitchT = 1; this.pitch = 1; this.pitchSet = false;
    this.modeB = false;
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
      if (m.pitch !== undefined) {
        this.pitchT = m.pitch;
        if (!this.pitchSet) { this.pitch = m.pitch; this.pitchSet = true; }
      }
      if (m.pitchMode !== undefined) this.modeB = m.pitchMode === 'B';
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
      const p = this.pitch;
      const pI = this.modeB ? Math.min(p, IDLE_PITCH_MAX) : p;
      const sIdle = this.rpm * pI;      // sound RPM of the idle, and what the crossfade follows
      // idle <-> engine crossfade (equal power)
      let mix = 1;
      if (this.I) {
        const ir = this.I.rpm;
        mix = Math.max(smooth(ir * 1.06, ir * 1.45, sIdle), smooth(0.16, 0.42, this.load), this.bankMin);
      }
      let sBank = sIdle;
      if (this.modeB) {
        if (p > pI) sBank *= Math.pow(p / pI, mix);
        if (sBank > TOP_KNEE) sBank = TOP_KNEE + (sBank - TOP_KNEE) * TOP_SLOPE;
      }
      this.phi += sBank / (120 * sampleRate);
      let s = 0;
      if (mix > 0.001 && this.bank) s = Math.sin(mix * Math.PI / 2) * this.sampleBank(sBank);
      if (mix < 0.999 && this.I) s += Math.cos(mix * Math.PI / 2) * this.sampleIdle(sIdle);
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
