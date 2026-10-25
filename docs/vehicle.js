// Vehicle model: sensor fusion (phone motion + GPS + optional OBD2) and a Mustang GT drivetrain.
// Pure logic, no DOM, so it can run in the simulator and in tests.

export const G = 9.81;

// Ford Mustang GT (S550, 5.0 Coyote V8). 10R80 ratios: Ford chart (2018+ automatic).
// MT82 ratios: CJ Pony Parts table for the S550 GT manual (2018 MT82-D4 ratios are disputed).
// 255/40R19 tyre (27.0 in, 686 mm).
export const TRANSMISSIONS = {
  mt82: {
    name: '6-speed manual (MT82, S550 GT)',
    ratios: [3.66, 2.43, 1.69, 1.31, 1.00, 0.65],
    final: 3.55,
    manual: true,
  },
  '10r80': {
    name: '10-speed automatic (10R80)',
    ratios: [4.696, 2.985, 2.146, 1.769, 1.520, 1.275, 1.000, 0.854, 0.689, 0.636],
    final: 3.15,
    manual: false,
  },
};
export const TYRE_CIRC = Math.PI * (19 * 0.0254 + 2 * 0.255 * 0.40);   // 2.157 m

export const DEFAULTS = {
  trans: 'mt82',
  idleRpm: 850,
  // Aggression (g of longitudinal acceleration) -> upshift RPM, as requested:
  // slow -> 2000, medium -> 3000, fast -> 4000, interpolated in between.
  gSlow: 0.10, gMed: 0.20, gFast: 0.32,
  rpmSlow: 2000, rpmMed: 3000, rpmFast: 4000,
  minRpmAfterUpshift: 1150,
  downshiftRpm: 1250,       // coasting downshift; braking raises it up to +600
  loadFullG: 0.22,          // acceleration that counts as full throttle
  gpsLatency: 0.45,         // s, iPhone GPS speed lag behind reality
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// ------------------------------------------------------------------ fusion

export class Fusion {
  constructor(cfg = DEFAULTS) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.g = null;                // gravity vector (device frame, m/s^2)
    this.fwd = null;              // unit forward axis (device frame, horizontal)
    this.fwdSource = 'none';      // none | preset | launch | gps
    this.M = [0, 0, 0]; this.Mw = 0;
    this.v = 0;                   // m/s
    this.aLong = 0;               // m/s^2, raw
    this.aLongF = 0;              // filtered (~0.12 s): aggression, shift decisions
    this.aLongQ = 0;              // fast (~45 ms): throttle/load, the cue heard as response
    this.bias = 0;
    this.hist = [];               // [t, v] for latency-compensated GPS correction
    this.still = 0;               // seconds of stillness
    this.varBuf = [];
    this.handling = false;
    this.lastT = null;
    this.gpsLast = null;          // {t, v}
    this.hAcc = [0, 0, 0]; this.hN = 0;   // horizontal accel accumulated between GPS fixes
    this.launch = null;
    this.lastStill = -1e9;
    this.gpsFresh = 0;
    this.obdFresh = 0;
  }

  // Phone motion sample. a: linear acceleration (gravity removed) or null; ag: including gravity;
  // rot: rotation rate deg/s {alpha,beta,gamma}; t: seconds.
  motion(t, a, ag, rot) {
    const dt = this.lastT == null ? 1 / 60 : clamp(t - this.lastT, 0.001, 0.1);
    this.lastT = t;
    if (!ag) return;
    // Gravity: when the OS gives linear acceleration, (ag - a) is its own fused gravity
    // estimate (gyro-stabilised), which doesn't tilt during long accelerations.
    const gNow = a ? v3.sub(ag, a) : ag;
    const kg = 1 - Math.exp(-dt / (a ? 0.15 : 0.6));
    this.g = this.g ? this.g.map((x, i) => x + (gNow[i] - x) * kg) : gNow.slice();
    if (!a) a = v3.sub(ag, this.g);
    const up = v3.norm(this.g);
    const h = v3.sub(a, v3.scale(up, v3.dot(a, up)));        // horizontal part
    const rr = rot ? Math.hypot(rot.alpha || 0, rot.beta || 0, rot.gamma || 0) : 0;
    this.handling = rr > 90;

    if (!this.fwd) this.presetForward(up);

    // stillness detector (for zero-velocity updates and bias)
    const mag = v3.len(a);
    this.varBuf.push(mag); if (this.varBuf.length > 60) this.varBuf.shift();
    const mean = this.varBuf.reduce((s, x) => s + x, 0) / this.varBuf.length;
    const sd = Math.sqrt(this.varBuf.reduce((s, x) => s + (x - mean) ** 2, 0) / this.varBuf.length);
    this.rrF = (this.rrF || 0) + (rr - (this.rrF || 0)) * (1 - Math.exp(-dt / 0.3));
    const quiet = sd < 0.06 && mean < 0.2 && this.rrF < 5;
    this.still = quiet ? this.still + dt : 0;

    let along = this.handling ? 0 : v3.dot(h, this.fwd) - this.bias;
    this.learnLaunch(t, h, dt);
    this.aLong = along;
    this.aLongF += (along - this.aLongF) * (1 - Math.exp(-dt / 0.12));
    this.aLongQ += (along - this.aLongQ) * (1 - Math.exp(-dt / 0.045));

    // integrate speed
    this.v = Math.max(0, this.v + along * dt);
    const gpsSaysSlow = this.gpsLast && t - this.gpsLast.t < 3 && this.gpsLast.v < 1.0;
    const noGps = !this.gpsLast || t - this.gpsLast.t > 3;
    if (this.still > 0.8 && (gpsSaysSlow || (noGps && this.v < 3))) {
      this.v *= Math.exp(-dt / 0.15);
      if (this.v < 0.05) this.v = 0;
      this.bias += (v3.dot(h, this.fwd) - this.bias) * (1 - Math.exp(-dt / 2));
    }
    this.hist.push([t, this.v]);
    while (this.hist.length && this.hist[0][0] < t - 4) this.hist.shift();
    if (!this.handling) { this.hAcc = this.hAcc.map((x, i) => x + h[i]); this.hN++; }
  }

  presetForward(up) {
    // Phone in a dash mount, screen facing the driver: forward is out of the back (-Z).
    // If the phone lies flat, use its top edge (+Y) instead.
    let f = [0, 0, -1];
    if (Math.abs(v3.dot(f, up)) > 0.8) f = [0, 1, 0];
    f = v3.sub(f, v3.scale(up, v3.dot(f, up)));
    this.fwd = v3.norm(f);
    this.fwdSource = 'preset';
  }

  // First firm pull-away from standstill defines forward (works without GPS).
  learnLaunch(t, h, dt) {
    if (this.fwdSource === 'gps' || this.fwdSource === 'launch') return;
    const hm = v3.len(h);
    if (this.still > 0.5) this.lastStill = t;
    if (this.handling) { this.launch = null; return; }
    if (!this.launch) {
      // only a pull-away straight from standstill counts (not braking to a stop)
      if (hm > 0.7 && t - this.lastStill < 0.6) this.launch = { t0: t, sum: [0, 0, 0], abs: 0, n: 0 };
      return;
    }
    const L = this.launch;
    L.sum = L.sum.map((x, i) => x + h[i]); L.abs += hm; L.n++;
    if (t - L.t0 < 0.6) return;
    const mean = v3.len(L.sum) / L.n, consistency = v3.len(L.sum) / L.abs;
    if (mean > 0.6 && consistency > 0.75 && this.gpsSlowOrUnknown(t)) {
      this.fwd = v3.norm(L.sum); this.fwdSource = 'launch';
      this.v = Math.max(this.v, mean * (t - L.t0));
    }
    this.launch = null;
  }


  gpsSlowOrUnknown(t) {
    return !this.gpsLast || t - this.gpsLast.t > 3 || this.gpsLast.v < 3;
  }

  // GPS fix. speed m/s (null if unknown), acc metres, t seconds (fix time, same clock as motion).
  gps(t, speed, acc) {
    if (speed == null || speed < 0 || !(acc < 60)) return;
    this.gpsFresh = t;
    const prev = this.gpsLast;
    this.gpsLast = { t, v: speed };
    // learn forward axis from GPS acceleration vs horizontal phone acceleration
    if (prev && this.hN > 5) {
      const dtg = t - prev.t;
      if (dtg > 0.4 && dtg < 2.5) {
        const ag = (speed - prev.v) / dtg;
        if (Math.abs(ag) > 0.6) {
          const hm = this.hAcc.map((x) => x / this.hN);
          this.M = this.M.map((x, i) => x + hm[i] * ag);
          this.Mw += Math.abs(ag);
          if (this.Mw > 4 && this.g) {
            const up = v3.norm(this.g);
            let f = v3.sub(this.M, v3.scale(up, v3.dot(this.M, up)));
            if (v3.len(f) > 0.1) {
              f = v3.norm(f);
              this.fwd = this.fwdSource === 'gps' ? v3.norm(this.fwd.map((x, i) => x * 0.8 + f[i] * 0.2)) : f;
              this.fwdSource = 'gps';
            }
          }
        }
      }
    }
    this.hAcc = [0, 0, 0]; this.hN = 0;
    if (t - this.obdFresh < 2) return;          // OBD speed is better; GPS only teaches direction
    this.correct(t - this.cfg.gpsLatency, speed, 0.35, 0.04);
  }

  // OBD2 vehicle speed (m/s).
  obd(t, speed) {
    this.obdFresh = t;
    this.correct(t - 0.12, speed, 0.6, 0.03);
  }

  correct(tRef, speed, kp, ki) {
    let vPast = this.v;
    for (let i = this.hist.length - 1; i >= 0; i--) if (this.hist[i][0] <= tRef) { vPast = this.hist[i][1]; break; }
    const e = speed - vPast;
    this.v = Math.max(0, this.v + kp * e);
    if (speed > 2) this.bias = clamp(this.bias - ki * e, -0.6, 0.6);
    for (const h of this.hist) h[1] = Math.max(0, h[1] + kp * e);
  }
}

// ------------------------------------------------------------------ drivetrain

export class Drivetrain {
  constructor(cfg = DEFAULTS) {
    this.cfg = cfg;
    this.setTransmission(cfg.trans);
    this.gear = 1;
    this.rpm = cfg.idleRpm;
    this.load = 0;
    this.aggr = 0;            // acceleration envelope (g)
    this.shift = null;        // {from,to,t,dur,kind,rpm0}
    this.clutch = 0;          // 1 = disengaged (standing still)
    this.prevRpm = this.rpm;
    this.rate = 0;
    this.events = [];
  }

  setTransmission(key) {
    this.tr = TRANSMISSIONS[key] || TRANSMISSIONS.mt82;
    this.gear = Math.min(this.gear || 1, this.tr.ratios.length);
  }

  wheelRpm(v, gear) { return v / TYRE_CIRC * 60 * this.tr.ratios[gear - 1] * this.tr.final; }

  shiftPoint() {
    const c = this.cfg, a = this.aggr;
    if (a <= c.gSlow) return c.rpmSlow;
    if (a <= c.gMed) return lerp(c.rpmSlow, c.rpmMed, (a - c.gSlow) / (c.gMed - c.gSlow));
    if (a <= c.gFast) return lerp(c.rpmMed, c.rpmFast, (a - c.gMed) / (c.gFast - c.gMed));
    return c.rpmFast;
  }

  // v m/s; aLoad: fast-filtered accel for throttle; aShift: smoother accel for aggression/shifts
  update(v, aLoad, dt, aShift = aLoad) {
    const c = this.cfg, gA = aShift / G, gL = aLoad / G;
    // throttle estimate: decel -> overrun, ~0 -> cruise part-throttle, accel -> up to full
    const cruise = v > 2 ? 0.25 : 0.12;
    let pedal = smoothstep(-0.035, -0.008, gL) * cruise + smoothstep(0.01, c.loadFullG, gL) * (1 - cruise);
    // aggression envelope: fast attack, slow release
    const target = Math.max(0, gA);
    const k = target > this.aggr ? 1 - Math.exp(-dt / 0.25) : 1 - Math.exp(-dt / 2.5);
    this.aggr += (target - this.aggr) * k;

    const N = this.tr.ratios.length;
    const sp = this.shiftPoint();
    this.cruiseT = pedal > 0.1 && pedal <= 0.3 && Math.abs(gA) < 0.02 ? (this.cruiseT || 0) + dt : 0;
    let rpm, load = pedal;

    if (this.shift) {
      const s = this.shift;
      s.t += dt;
      const u = clamp(s.t / s.dur, 0, 1);
      const tgt = this.wheelRpm(v, s.to);
      if (s.kind === 'up') {
        // lift, clutch in, revs fall toward the next gear, re-engage
        const e = 1 - Math.pow(1 - u, 2);
        rpm = lerp(s.rpm0, Math.max(tgt, c.idleRpm), e);
        load = this.tr.manual ? (u < 0.8 ? 0 : pedal * (u - 0.8) / 0.2) : pedal * 0.35;
      } else {
        // rev-matched downshift: blip up to the lower gear's speed
        const e = Math.sin(u * Math.PI / 2);
        rpm = lerp(s.rpm0, tgt, e);
        load = s.kick ? pedal : (u < 0.6 ? 0.55 : 0.05);
      }
      if (u >= 1) { this.gear = s.to; this.shift = null; }
    } else {
      const wr = this.wheelRpm(v, this.gear);
      // standing / crawling: clutch in (or converter), engine idles, revs with throttle
      if (v < 1.2 && this.gear <= 1) {
        this.gear = 1;
        const launch = c.idleRpm + pedal * (1100 + 900 * smoothstep(0.1, 0.35, this.aggr));
        rpm = Math.max(wr, launch);
        if (pedal < 0.15) load = Math.min(load, 0.12);
      } else if (this.gear === 1 && wr < c.idleRpm + 700 * pedal) {
        rpm = Math.max(wr, c.idleRpm + 700 * pedal);       // clutch slip on pull-away
      } else {
        rpm = wr;
      }
      if (!this.tr.manual) rpm *= 1 + (0.02 + 0.08 * pedal) * smoothstep(12, 0, v);   // converter slip

      // upshift
      if (this.gear < N && rpm >= sp && pedal > 0.12) {
        const next = this.wheelRpm(v, this.gear + 1);
        if (next >= c.minRpmAfterUpshift * 0.85 || rpm > c.rpmFast) this.startShift('up', this.gear + 1, rpm);
      } else if (this.gear < N && this.cruiseT > 1.2 && rpm > 2200 &&
                 this.wheelRpm(v, this.gear + 1) >= c.minRpmAfterUpshift) {
        this.startShift('up', this.gear + 1, rpm);               // short-shift when cruising
      }
      // downshift: coasting below downshiftRpm, or kickdown when accelerating hard in a tall gear
      else if (this.gear > 1 && v > 1.2) {
        const lower = this.wheelRpm(v, this.gear - 1);
        // braking harder -> downshift earlier (higher rpm), with a rev-matching blip
        const downAt = c.downshiftRpm + 600 * smoothstep(0.05, 0.3, -gA);
        const intoFirst = this.gear === 2 && v > 5.5;            // nobody selects 1st above ~20 km/h
        if (rpm < downAt && pedal < 0.3 && lower < 3200 && !intoFirst) this.startShift('down', this.gear - 1, rpm);
        else if (pedal > 0.55 && rpm < sp * 0.55 && lower < sp * 0.9 && !intoFirst) this.startShift('down', this.gear - 1, rpm, true);
        else if (rpm < c.minRpmAfterUpshift * 0.9) this.startShift('down', this.gear - 1, rpm, pedal > 0.3);
      }
      if (v < 1.2 && this.gear > 1) { this.gear = 1; }
    }
    rpm = clamp(rpm, c.idleRpm * 0.95, 6500);
    this.rate = (rpm - this.prevRpm) / dt;
    this.prevRpm = rpm;
    this.rpm = rpm;
    this.load = clamp(load, 0, 1);
    return this;
  }

  startShift(kind, to, rpm0, kick = false) {
    const a = smoothstep(0.08, 0.32, this.aggr);
    const dur = this.tr.manual
      ? (kind === 'up' ? lerp(0.55, 0.28, a) : lerp(0.35, 0.22, a))
      : (kind === 'up' ? lerp(0.3, 0.16, a) : 0.2);
    this.shift = { kind, to, from: this.gear, t: 0, dur, rpm0, kick };
    this.events.push({ kind, from: this.gear, to, rpm: Math.round(rpm0) });
    if (this.events.length > 20) this.events.shift();
  }
}

// ------------------------------------------------------------------ simulator (Ioniq 5 AWD-ish)

export class SimCar {
  constructor() { this.v = 0; this.a = 0; }
  // pedal 0..1, brake 0..1
  step(pedal, brake, dt) {
    const m = 2150, P = 239e3, Fmax = m * 5.0;
    const drive = pedal > 0 ? Math.min(Fmax, P / Math.max(this.v, 1)) * pedal : 0;
    const drag = 0.5 * 1.2 * 0.288 * 2.6 * this.v * this.v + 0.012 * m * G;
    const regen = pedal < 0.02 && this.v > 0.5 ? 0.06 * m * G : 0;
    const brk = brake * 0.75 * m * G;
    let a = (drive - (this.v > 0.05 ? drag + regen + brk : 0)) / m;
    // driveline lag ~0.1 s
    this.a += (a - this.a) * (1 - Math.exp(-dt / 0.1));
    this.v = Math.max(0, this.v + this.a * dt);
    if (this.v === 0 && this.a < 0) this.a = 0;
    return this;
  }
}
