// Dev tool: feeds synthetic phone-motion + GPS data through Fusion and reports tracking error.
import { Fusion, SimCar, DEFAULTS } from '../vehicle.js';
import { SCRIPT } from './render-drive.js';

function rot(yawDeg, pitchDeg, rollDeg) {
  const [y, p, r] = [yawDeg, pitchDeg, rollDeg].map((d) => d * Math.PI / 180);
  const Rz = [[Math.cos(y), -Math.sin(y), 0], [Math.sin(y), Math.cos(y), 0], [0, 0, 1]];
  const Rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]];
  const Ry = [[Math.cos(r), 0, Math.sin(r)], [0, 1, 0], [-Math.sin(r), 0, Math.cos(r)]];
  const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, _, k) => s + A[A.indexOf(row)][k] * B[k][j], 0)));
  return mul(mul(Rz, Rx), Ry);
}
const apply = (R, v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s * Math.SQRT2; };

// mount: 'dash' = screen facing driver (device -Z forward), 'flat' = on console, top forward
export function run({ mount = 'dash', yaw = 12, tilt = 20, invert = false, gps = true, gpsLag = 0.6, dur = 43 } = {}) {
  // car frame: x right, y forward, z up. Device frame for dash mount: x right, y up, z toward driver.
  const base = mount === 'dash' ? [[1, 0, 0], [0, 0, 1], [0, -1, 0]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const R0 = rot(yaw, tilt, 3);
  const R = base.map((row) => [0, 1, 2].map((j) => row.reduce((s, _, k) => s + row[k] * R0[k][j], 0)));
  const fusion = new Fusion({ ...DEFAULTS });
  const car = new SimCar();
  const dt = 1 / 60;
  const at = (t) => { let r = SCRIPT[0]; for (const x of SCRIPT) if (x[0] <= t) r = x; return r; };
  const hist = [];
  let err2 = 0, n = 0, aerr2 = 0, nextGps = 0.3, learnedAt = null;
  const bias = [0.08, -0.05, 0.06];
  for (let t = 0; t < dur; t += dt) {
    const [, pedal, brake] = at(t);
    car.step(pedal, brake, dt);
    const lat = Math.sin(t / 3) * (car.v > 5 ? 1.2 : 0);
    const aCar = [lat, car.a, 0];
    const vib = car.v > 0.3 ? 0.25 : 0.01;
    let a = apply(R, aCar).map((x, i) => x + bias[i] + vib * gauss());
    let ag = a.map((x, i) => x + apply(R, [0, 0, 9.81])[i]);
    if (invert) { a = a.map((x) => -x); ag = ag.map((x) => -x); }
    const gn = car.v > 0.3 ? 2 : 0.3;
    const rr = { alpha: gn * gauss(), beta: gn * gauss(), gamma: gn * gauss() };
    fusion.motion(t, a, ag, rr);
    hist.push([t, car.v]);
    if (gps && t >= nextGps) {
      nextGps += 1;
      const tl = t - gpsLag; let vl = 0; for (const h of hist) if (h[0] <= tl) vl = h[1];
      fusion.gps(t - 0.1, Math.max(0, vl + 0.15 * gauss()), 8);
    }
    if (!learnedAt && (fusion.fwdSource === 'launch' || fusion.fwdSource === 'gps')) learnedAt = t;
    if (t > 5) { err2 += (fusion.v - car.v) ** 2; aerr2 += (fusion.aLongF - car.a) ** 2; n++; }
  }
  return {
    mount, invert, gps, vRmsErr: +Math.sqrt(err2 / n).toFixed(2), aRmsErr: +Math.sqrt(aerr2 / n).toFixed(2),
    fwd: fusion.fwdSource, learnedAt: learnedAt && +learnedAt.toFixed(1), vEnd: +fusion.v.toFixed(2), vTrueEnd: +car.v.toFixed(2),
  };
}
