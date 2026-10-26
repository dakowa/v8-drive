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
  idleRpm: 705,             // set from the chosen idle recording
  // Aggression (g of longitudinal acceleration) -> upshift RPM, as requested:
  // slow -> 2000, medium -> 3000, fast -> 4000, maximum -> 5000, interpolated in between.
  gSlow: 0.10, gMed: 0.20, gFast: 0.32, gMax: 0.45,
  rpmSlow: 2000, rpmMed: 3000, rpmFast: 4000, rpmMax: 5000,
  // Slowing down: rev-matched downshift once revs fall below downRpm (2000-4000), or, with
  // downFollow, below the shift point of your recent driving.
  downRpm: 2500,
  downFollow: false,
  // Sport mode: keep revs at or above sportMinRpm (0 = off) unless slower than sportBelowKmh.
  sportMinRpm: 0,
  sportBelowKmh: 10,
  minRpmAfterUpshift: 1150,
  downshiftRpm: 1250,       // coasting downshift; braking raises it up to +600
  loadFullG: 0.22,          // acceleration that counts as full throttle
  // The EV can't pull 0.45 g at motorway speed (power-limited), so acceleration is judged
  // relative to what the car can deliver at the current speed: a = P/(m v). 2021 Ioniq 5
  // AWD: 225 kW / ~2100 kg ~ 105 W/kg; RWD 160 kW ~ 80 W/kg.
  powerPerKg: 105,
  gpsLatency: 0.45,         // s, iPhone GPS speed lag behind reality
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const LAUNCH_MIN = 1500;   // rpm
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
    this.sporty = 0;          // longer memory of aggr: how hard you've been driving
    this.prevDem = 0;
    this.kickT = 0; this.kickDem = 0; this.sinceKick = 10;
    this.shift = null;        // {from,to,t,dur,kind,rpm0}
    this.crawl = true;        // clutch slipping just above idle (standing, crawling)
    this.prevRpm = this.rpm;
    this.rate = 0;
    this.events = [];
  }

  setTransmission(key) {
    this.tr = TRANSMISSIONS[key] || TRANSMISSIONS.mt82;
    this.gear = Math.min(this.gear || 1, this.tr.ratios.length);
  }

  wheelRpm(v, gear) { return v / TYRE_CIRC * 60 * this.tr.ratios[gear - 1] * this.tr.final; }

  shiftPoint(a = this.aggr) {
    const c = this.cfg;
    const pts = [[c.gSlow, c.rpmSlow], [c.gMed, c.rpmMed], [c.gFast, c.rpmFast], [c.gMax, c.rpmMax]];
    if (a <= pts[0][0]) return pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [g0, r0] = pts[i], [g1, r1] = pts[i + 1];
      if (a <= g1) return lerp(r0, r1, (a - g0) / (g1 - g0));
    }
    return c.rpmMax;
  }

  // v m/s; aLoad: fast-filtered accel for throttle; aShift: smoother accel for aggression/shifts
  update(v, aLoad, dt, aShift = aLoad) {
    const c = this.cfg;
    // effort scaling: at speed the EV runs out of power, so the same pedal gives less g
    const gAvail = Math.min(c.gMax, c.powerPerKg / (Math.max(v, 1) * G));
    const boost = c.gMax / Math.max(gAvail, 0.05);
    const gA = aShift / G * (aShift > 0 ? boost : 1), gL = aLoad / G * (aLoad > 0 ? boost : 1);
    // throttle estimate: decel -> overrun, ~0 -> cruise part-throttle, accel -> up to full
    // (part throttle rises gradually through 5-16 km/h, so crawling has no step in it)
    const cruise = 0.12 + 0.13 * smoothstep(1.5, 4.5, v);
    let pedal = smoothstep(-0.035, -0.008, gL) * cruise + smoothstep(0.01, c.loadFullG, gL) * (1 - cruise);
    // aggression envelope: fast attack, slow release
    const target = Math.max(0, gA);
    const k = target > this.aggr ? 1 - Math.exp(-dt / 0.25) : 1 - Math.exp(-dt / 2.5);
    this.aggr += (target - this.aggr) * k;
    this.sporty = Math.max(this.aggr, this.sporty * Math.exp(-dt / 8));
    // throttle demand for kickdown, relative to the maximum-acceleration threshold
    const dem = smoothstep(0.02, c.gMax, gL);
    const demRate = (dem - this.prevDem) / dt;
    this.prevDem = dem;

    const N = this.tr.ratios.length;
    const sp = this.shiftPoint();
    const kmh = v * 3.6;
    const sportOn = c.sportMinRpm > 0 && kmh >= c.sportBelowKmh;
    const sportMin = sportOn ? c.sportMinRpm : 0;
    this.cruiseT = pedal > 0.1 && pedal <= 0.3 && Math.abs(gA) < 0.02 ? (this.cruiseT || 0) + dt : 0;
    this.slowT = pedal < 0.15 && gA < -0.03 ? (this.slowT || 0) + dt : 0;
    this.sinceUp = (this.sinceUp ?? 10) + dt;
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
        load = s.kick ? Math.max(pedal, 0.8) : (u < 0.6 ? 0.55 : 0.05);
      }
      if (u >= 1) { this.gear = s.to; this.shift = null; }
    } else {
      let rpmT, slowSmooth = false;
      // Crawling (below 13 km/h on a light throttle): the clutch slips with the engine just
      // above idle, so the real idle recording plays. A firm throttle, or 16 km/h, ends it.
      // The gap between the thresholds keeps a noisy throttle estimate from flapping it.
      if (this.crawl) {
        if (pedal > 0.30 || kmh > 16) {
          this.crawl = false;
          if (this.wheelRpm(v, 2) >= c.idleRpm * 1.25) this.gear = 2;
        }
      } else if (pedal < 0.20 && kmh < 13 && this.gear <= 2) {
        this.crawl = true;
      }
      const wr = this.wheelRpm(v, this.gear);
      // pulling away the clutch slips at 1500 rpm or more: the recordings have no clean
      // on-throttle sound below that (only fast sweeps)
      const launch = Math.max(LAUNCH_MIN, c.idleRpm + 250 + pedal * (700 + 900 * smoothstep(0.1, 0.35, this.aggr)));
      if (this.crawl) {
        this.gear = 1;
        rpmT = c.idleRpm * (1.16 + 0.1 * smoothstep(0.12, 0.3, pedal));
        load = Math.min(load, 0.15);
      } else if (v < 1.2) {
        // pulling away from a standstill: bite immediately
        this.gear = 1;
        rpmT = Math.max(wr, LAUNCH_MIN, c.idleRpm + pedal * (1100 + 900 * smoothstep(0.1, 0.35, this.aggr)));
      } else if (this.gear === 1 && wr < launch) {
        rpmT = launch;   // clutch slip until the wheels catch up
      } else {
        rpmT = wr;
      }
      slowSmooth = kmh < 20;
      // at low speed revs move like a clutch/converter engaging, not instantly with sensor noise
      if (slowSmooth) {
        // rising revs follow quickly (throttle response), falling revs ease down like a clutch
        const prev = this.prevRpm || rpmT;
        rpm = prev + (rpmT - prev) * (1 - Math.exp(-dt / (rpmT > prev ? 0.03 : 0.18)));
      } else {
        rpm = rpmT;
      }
      if (!this.tr.manual) rpm *= 1 + (0.02 + 0.08 * pedal) * smoothstep(12, 0, v);   // converter slip

      // upshift (in sport mode only once the next gear still keeps revs above the minimum)
      const nextR = this.gear < N ? this.wheelRpm(v, this.gear + 1) : 0;
      const sportOk = nextR >= sportMin || rpm > 6300;
      if (this.gear < N && rpm >= sp && pedal > 0.12 && sportOk) {
        if (nextR >= c.minRpmAfterUpshift * 0.85 || rpm > c.rpmMax) this.startShift('up', this.gear + 1, rpm);
      } else if (this.gear < N && this.cruiseT > 1.2 && rpm > Math.max(2200, sportMin * 1.25) &&
                 nextR >= Math.max(c.minRpmAfterUpshift, sportMin)) {
        this.startShift('up', this.gear + 1, rpm);               // short-shift when cruising
      } else if (sportOn && this.gear > 1 && rpm < sportMin && this.sinceUp > 1.0 && !this.kickT &&
                 this.wheelRpm(v, this.gear - 1) <= 6000) {
        this.startShift('down', this.gear - 1, rpm, pedal > 0.3);  // sport mode: stay in the band
      }
      else if (this.gear > 1 && v > 1.2) {
        const lower = this.wheelRpm(v, this.gear - 1);
        const intoFirst = this.gear === 2 && v > 5.5;            // nobody selects 1st above ~20 km/h
        // Kickdown (from 3rd up): pressing hard while revs are far below where that demand
        // would shift. One gear normally; two at full demand (like real multi-gear kickdowns,
        // which are gated by high throttle), never past the gear that would exceed the target.
        const T = this.shiftPoint(Math.max(gL, 0));
        const fits = (g) => g >= 2 && this.wheelRpm(v, g) <= Math.min(T * 0.95, 5500);
        const wantsKick = this.gear >= 3 && (dem >= 0.6 || (dem >= 0.4 && demRate > 2.5)) && rpm < T * 0.62;
        // judge the pedal over 150 ms, then pick the target gear in one go (like a real TCU)
        this.kickT = wantsKick ? this.kickT + dt : 0;
        this.kickDem = wantsKick ? Math.max(this.kickDem, dem) : 0;
        this.sinceKick += dt;
        if (this.kickT >= 0.15 && this.sinceKick > 1.0) {
          const two = this.gear >= 4 && this.kickDem >= 0.95 && fits(this.gear - 2);
          if (two || fits(this.gear - 1)) {
            this.startShift('down', this.gear - (two ? 2 : 1), rpm, true);
            this.sinceKick = 0; this.kickT = 0;
          }
        } else if (wantsKick) {
          // waiting for the kickdown decision
        } else if (pedal < 0.15 && gA < -0.03 && !intoFirst && this.slowT > 0.8 && this.sinceUp > 1.5) {
          // slowing: downshift with a rev-matching blip once revs drop below the threshold
          // (2000-4000 following your recent driving, or fixed 2000)
          let D = c.downFollow ? Math.min(c.rpmFast, Math.max(c.downRpm, this.shiftPoint(this.sporty))) : c.downRpm;
          D = Math.max(D, sportMin);
          const downAt = Math.max(D, c.downshiftRpm + 600 * smoothstep(0.05, 0.3, -gA));
          if (rpm < downAt && lower <= Math.min(5500, Math.max(D * 1.5, 3000))) this.startShift('down', this.gear - 1, rpm);
        } else if (rpm < c.downshiftRpm && pedal < 0.3 && lower < 3200 && !intoFirst) {
          this.startShift('down', this.gear - 1, rpm);
        } else if (rpm < c.minRpmAfterUpshift * 0.9) {
          this.startShift('down', this.gear - 1, rpm, pedal > 0.3);
        }
      }
      if (v < 1.2 && this.gear > 1) { this.gear = 1; }
    }
    rpm = clamp(rpm, c.idleRpm * 0.95, 6500);
    // below ~20 km/h, smooth the throttle so road bumps don't flutter the sound between idle and engine
    // (only easing off is smoothed: pressing the pedal still bites at once)
    if (!this.shift && v < 5.5 && load < (this.loadS ?? load)) this.loadS = this.loadS + (load - this.loadS) * (1 - Math.exp(-dt / 0.25));
    else this.loadS = load;
    load = this.loadS;
    this.rate = (rpm - this.prevRpm) / dt;
    this.prevRpm = rpm;
    this.rpm = rpm;
    this.load = clamp(load, 0, 1);
    return this;
  }

  startShift(kind, to, rpm0, kick = false) {
    const a = smoothstep(0.08, 0.32, this.aggr);
    let dur = this.tr.manual
      ? (kind === 'up' ? lerp(0.55, 0.28, a) : lerp(0.35, 0.22, a))
      : (kind === 'up' ? lerp(0.3, 0.16, a) : 0.2);
    if (Math.abs(this.gear - to) > 1) dur *= 1.3;
    this.shift = { kind, to, from: this.gear, t: 0, dur, rpm0, kick };
    if (kind === 'up') this.sinceUp = 0;
    this.events.push({ kind: kick ? 'kickdown' : kind, from: this.gear, to, rpm: Math.round(rpm0) });
    if (this.events.length > 20) this.events.shift();
  }
}

// ------------------------------------------------------------------ simulator (Ioniq 5 AWD-ish)

export const REGEN3_G = 0.18;   // Ioniq 5 lift-off regen, level 3 (i-Pedal tops out near 0.25 g)

export class SimCar {
  constructor() { this.v = 0; this.a = 0; }
  // throttle 0..1, regen 0..1 (1 = foot fully off, level 3), brake 0..1
  step(pedal, brake, dt, regenAmt = pedal > 0.02 ? 0 : 1) {
    const m = 2150, P = 239e3, Fmax = m * 5.0;
    const drive = pedal > 0 ? Math.min(Fmax, P / Math.max(this.v, 1)) * pedal : 0;
    const drag = 0.5 * 1.2 * 0.288 * 2.6 * this.v * this.v + 0.012 * m * G;
    const regen = this.v > 0.5 ? regenAmt * REGEN3_G * m * G * Math.min(1, this.v / 3) : 0;
    const brk = brake * 0.75 * m * G;
    let a = (drive - (this.v > 0.05 ? drag + regen + brk : 0)) / m;
    // driveline lag ~0.1 s
    this.a += (a - this.a) * (1 - Math.exp(-dt / 0.1));
    this.v = Math.max(0, this.v + this.a * dt);
    if (this.v === 0 && this.a < 0) this.a = 0;
    return this;
  }
}
