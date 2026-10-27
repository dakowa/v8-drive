// Dev tool: replays a recorded drive through the app's own Fusion + Drivetrain, with setting
// overrides, to answer "what would this drive have done with gMed 0.18?" before changing
// anything. Also renders the sound of any stretch of a drive, as heard or with overrides.
// Usage (from the app page console; tools/pull_drives.py links its drives/ folder to dev/drives):
//   const r = await import('./dev/replay.js');
//   const d = await r.loadDrive('dev/drives/v8drive-20261027181502.json.gz');
//   r.check(d);                                   // replay vs log: should match closely
//   const x = r.replay(d, { gMed: 0.18 });         // {rows, events, cfg}
//   r.compare(d, x);                               // upshift RPMs etc., logged vs replayed
//   await r.renderSpan('mark1', d, 120, 135, { ...__v8.banks, over: { gMed: 0.18 } });
import { Fusion, Drivetrain, SimCar, DEFAULTS } from '../vehicle.js?v=12';
import { render } from './render-drive.js';

export const ROW = { t: 0, v: 1, a: 2, aRaw: 3, rpm: 4, gear: 5, load: 6, aggr: 7, aq: 8, shift: 9 };

export async function loadDrive(url) {
  const r = await fetch(url);
  let s = r.body;
  if (url.endsWith('.gz')) s = s.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(s).text());
}

// Re-run the drive. Settings start as recorded, mid-drive changes ('set' events) are applied
// when they happened, and `over` wins over both. Without motion data (simulator drives, old
// logs) the logged speed and acceleration drive the Drivetrain directly.
export function replay(d, over = {}, { hz = 60 } = {}) {
  const cfg = { ...DEFAULTS, ...(d.settings || {}), ...over };
  const sets = (d.events || []).filter((e) => e[1] === 'set' && !(e[2] in over));
  const fusion = new Fusion(cfg), drive = new Drivetrain(cfg);
  const useMotion = (d.motion || []).length > 100 && !d.sim;
  const M = d.motion || [], Gp = (d.gps || []).filter((g) => g[3] != null).map((g) => [g[0], g[0] - (g[6] || 0), g[3], g[4]]);
  const R = d.rows, T = R.length ? R[R.length - 1][0] : 0;
  const rows = [], events = [];
  let mi = 0, gi = 0, ri = 0, si = 0, nextRow = 0, lastEv = null;
  const nul = (x) => (x == null ? NaN : x);
  for (let t = R.length ? R[0][0] : 0; t <= T; t += 1 / hz) {
    while (si < sets.length && sets[si][0] <= t) { cfg[sets[si][2]] = sets[si][3]; si++; }
    let v, aF, aQ;
    if (useMotion) {
      while (mi < M.length && M[mi][0] <= t + 5e-4) {
        const m = M[mi++].map(nul);
        const a = Number.isNaN(m[1]) ? null : [m[1], m[2], m[3]];
        const g = Number.isNaN(m[4]) ? null : [m[4], m[5], m[6]];
        fusion.motion(m[0], a, g, Number.isNaN(m[7]) ? null : { alpha: m[7], beta: m[8], gamma: m[9] });
      }
      while (gi < Gp.length && Gp[gi][0] <= t + 5e-4) { const g = Gp[gi++]; fusion.gps(Math.min(g[0], g[1]), g[2], g[3]); }
      v = fusion.v; aF = fusion.aLongF; aQ = fusion.aLongQ;
    } else {
      while (ri < R.length - 1 && R[ri + 1][0] <= t) ri++;
      const r = R[ri];
      v = r[ROW.v]; aF = r[ROW.a]; aQ = r[ROW.aq] ?? r[ROW.a];
    }
    drive.update(v, aQ, 1 / hz, aF);
    const e = drive.events[drive.events.length - 1];
    if (e && e !== lastEv) { events.push([+t.toFixed(3), e.kind, e.from, e.to, e.rpm]); lastEv = e; }
    if (t >= nextRow) {
      nextRow = t + 0.04;
      rows.push([+t.toFixed(3), +v.toFixed(2), +aF.toFixed(3), useMotion ? +fusion.aLong.toFixed(3) : NaN, Math.round(drive.rpm),
        drive.gear, +drive.load.toFixed(2), +drive.aggr.toFixed(3), +aQ.toFixed(3), drive.shift ? 1 : 0]);
    }
  }
  return { rows, events, cfg, usedMotion: useMotion };
}

const upshifts = (ev) => ev.filter((e) => e[1] === 'up').map((e) => e[4]);
const stats = (x) => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: x.length, p10: q(0.1), median: q(0.5), p90: q(0.9) };
};

// logged vs replayed: shifts and how far rpm/gear differ
export function compare(d, x) {
  const at = (rows, t) => { let lo = 0, hi = rows.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m; else hi = m; } return rows[lo]; };
  let dr = 0, dg = 0, n = 0;
  for (const r of d.rows) { const y = at(x.rows, r[0]); dr += Math.abs(r[4] - y[4]); dg += r[5] !== y[5] ? 1 : 0; n++; }
  const count = (ev, k) => ev.filter((e) => e[1] === k).length;
  return {
    usedMotion: x.usedMotion, rpmMeanAbsDiff: Math.round(dr / n), gearDiffPct: +(100 * dg / n).toFixed(1),
    logged: { up: count(d.events, 'up'), down: count(d.events, 'down'), kickdown: count(d.events, 'kickdown'), upshiftRpm: stats(upshifts(d.events)) },
    replayed: { up: count(x.events, 'up'), down: count(x.events, 'down'), kickdown: count(x.events, 'kickdown'), upshiftRpm: stats(upshifts(x.events)) },
  };
}

// replay with no overrides: how faithfully the tools reproduce what the phone did
export const check = (d) => compare(d, replay(d));

// Render the sound of t0..t1 of a drive (replayed with `over`) through the real worklet, to
// the dev upload server as render_<name>.wav.
export async function renderSpan(name, d, t0, t1, { bank, idle, over = {}, ...opts } = {}) {
  const x = replay(d, over);
  const cfg = x.cfg;
  const rows = x.rows.filter((r) => r[0] >= t0 && r[0] <= t1);
  // render-drive.js takes a pedal script; here the replayed drivetrain state is fed directly
  return render(name, { bank, idle, dur: t1 - t0, pitch: cfg.pitch ?? 1,
    states: rows.map((r) => ({ t: r[0] - t0, v: r[1], rpm: r[4], load: r[6] })), ...opts });
}

// A synthetic real drive in the recorded format (phone motion with noise and a tilted mount,
// lagging 1 Hz GPS), produced by the same loop as the app. For testing these tools.
export function synth({ script, dur = 120, lag = 0.6, seed = 7, over = {} } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const gauss = () => { let x = 0; for (let i = 0; i < 6; i++) x += rnd(); return x * Math.SQRT2; };
  script = script || [[0, 0, 0], [4, 0.25, 0], [14, 0.08, 0], [22, 0.6, 0], [30, 0.1, 0], [40, 1, 0], [47, 0, 0],
    [55, 0, 0.4], [62, 0.15, 0], [80, 0.4, 0], [88, 0.1, 0], [100, 0, 0.5], [108, 0, 0]];
  const at = (t) => { let r = script[0]; for (const x of script) if (x[0] <= t) r = x; return r; };
  const cfg = { ...DEFAULTS, idleRpm: 805, ...over };
  const fusion = new Fusion(cfg), drive = new Drivetrain(cfg), car = new SimCar();
  // dash mount, screen facing the driver, tilted 20 deg back: device y = up-ish, -z = forward
  const c = Math.cos(0.35), sn = Math.sin(0.35);
  const toDev = (a) => [a[0], a[2] * c + a[1] * sn, a[2] * sn - a[1] * c];   // car [right, fwd, up] -> device
  const rows = [], motion = [], gps = [], events = [], hist = [];
  let nextGps = 0.5, nextRow = 0, lastEv = null, lat = 51.5, lon = -0.12;
  const dt = 1 / 60;
  for (let t = 0; t < dur; t += dt) {
    const [, pedal, brake] = at(t);
    car.step(pedal, brake, dt);
    const vib = car.v > 0.3 ? 0.2 : 0.01;
    const a = toDev([0.4 * Math.sin(t / 3) * (car.v > 5), car.a, 0]).map((x) => x + 0.03 + vib * gauss());
    const g = a.map((x, i) => x + toDev([0, 0, 9.81])[i]);
    const rr = { alpha: gauss(), beta: gauss(), gamma: gauss() };
    fusion.motion(t, a, g, rr);
    motion.push([+t.toFixed(3), ...a.map((x) => +x.toFixed(3)), ...g.map((x) => +x.toFixed(3)), +rr.alpha.toFixed(1), +rr.beta.toFixed(1), +rr.gamma.toFixed(1)]);
    hist.push([t, car.v]);
    lat += car.v * dt / 111000;
    if (t >= nextGps) {
      nextGps += 1;
      let vl = 0; for (const h of hist) if (h[0] <= t - lag) vl = h[1];
      const sp = Math.max(0, vl + 0.1 * gauss());
      fusion.gps(t - 0.1, sp, 6);
      gps.push([+t.toFixed(3), +lat.toFixed(6), lon, +sp.toFixed(2), 6, 0, 0.1]);
    }
    drive.update(fusion.v, fusion.aLongQ, dt, fusion.aLongF);
    const e = drive.events[drive.events.length - 1];
    if (e && e !== lastEv) { events.push([+t.toFixed(3), e.kind, e.from, e.to, e.rpm]); lastEv = e; }
    if (t >= nextRow) {
      nextRow = t + 0.04;
      rows.push([+t.toFixed(3), +fusion.v.toFixed(2), +fusion.aLongF.toFixed(3), +fusion.aLong.toFixed(3), Math.round(drive.rpm),
        drive.gear, +drive.load.toFixed(2), +drive.aggr.toFixed(3), +fusion.aLongQ.toFixed(3), drive.shift ? 1 : 0, +car.v.toFixed(2)]);
    }
  }
  events.push([40.5, 'mark', 'wrong', 0, 0, 0]);
  return { app: 'v8drive', version: 3, appVersion: 'synth', id: 'synth', started: '2026-10-26T12:00:00.000Z', startedMs: Date.parse('2026-10-26T12:00:00Z'),
    columns: ['t', 'v', 'a', 'aRaw', 'rpm', 'gear', 'load', 'aggr', 'aq', 'shift', 'vTrue'],
    gpsColumns: ['t', 'lat', 'lon', 'speed', 'acc', 'heading', 'age'], motionColumns: ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'ra', 'rb', 'rg'],
    engine: 'gt500', sim: false, settings: cfg, ended: true, synthetic: { lag },
    rows, gps, events, motion };
}
