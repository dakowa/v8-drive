// Dev tool: renders a scripted drive through the engine offline (for A/B listening and checks).
// Usage (from the app page console, after the sounds have loaded):
//   const m = await import('./dev/render-drive.js'); await m.render('A', { ...__v8.banks, pitch: 1.2, pitchMode: 'B' });
import { Drivetrain, SimCar, DEFAULTS } from '../vehicle.js';

// [time s, pedal 0..1, brake 0..1]
export const SCRIPT = [
  [0, 0, 0], [5, 0.3, 0], [15, 0.1, 0], [19, 1.0, 0], [26, 0, 0], [33, 0.1, 0], [36, 1.0, 0], [40, 0, 0],
  [46, 0, 0.35], [49, 0, 0], [53, 0, 0],
];

function at(script, t) {
  let row = script[0];
  for (const r of script) if (r[0] <= t) row = r;
  return row;
}

export async function render(name, { sr = 44100, dur = 43, bank, idle = null, script = SCRIPT, lowSpeed = 'A',
  pitch = 1, pitchMode = 'A', cfgOver = {}, worklet = '../engine-worklet.js', proc = 'v8-engine', legacy = false,
  upload = 'http://127.0.0.1:8766/' } = {}) {
  const ctx = new OfflineAudioContext(1, Math.round(sr * dur), sr);
  await ctx.audioWorklet.addModule(new URL(worklet, import.meta.url));
  const node = new AudioWorkletNode(ctx, proc, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(ctx.destination);
  // legacy: the v3 worklet (message 'bankA', RPM already multiplied by pitch), for comparisons
  node.port.postMessage({ type: legacy ? 'bankA' : 'bank', sr: bank.sr, loops: bank.loops, data: bank.data });
  const cfg = { ...DEFAULTS, lowSpeed, ...cfgOver };
  if (idle) {
    cfg.idleRpm = idle.rpm;
    node.port.postMessage({ type: 'idle', sr: idle.sr, rpm: idle.rpm, data: idle.data, length: idle.data.length - 2 });
  }
  const drive = new Drivetrain(cfg);
  const car = new SimCar();
  const step = 1 / 60;
  const trace = [];
  for (let t = 0; t < dur - step; t += step) {
    const [, pedal, brake] = at(script, t);
    car.step(pedal, brake, step);
    drive.update(car.v, car.a, step);
    const bankMin = lowSpeed === 'B' ? Math.min(1, Math.max(0, (car.v - 0.6) / 0.6)) : 0;
    const gain = 0.72 + 0.38 * drive.load;
    const msg = legacy ? { type: 'state', rpm: drive.rpm * pitch, load: drive.load, gain }
      : { type: 'state', rpm: drive.rpm, pitch, pitchMode, bankMin, load: drive.load, gain };
    trace.push([+t.toFixed(3), +car.v.toFixed(2), +car.a.toFixed(2), Math.round(drive.rpm), drive.gear, +drive.load.toFixed(2)]);
    ctx.suspend(t).then(() => { node.port.postMessage(msg); ctx.resume(); });
  }
  const buf = await ctx.startRendering();
  const pcm = buf.getChannelData(0);
  const wav = toWav(pcm, sr);
  if (upload) {
    await fetch(upload + `render_${name}.wav`, { method: 'POST', body: wav });
    await fetch(upload + `trace_${name}.json`, { method: 'POST', body: JSON.stringify(trace) });
  }
  let peak = 0; for (const x of pcm) peak = Math.max(peak, Math.abs(x));
  return { peak, samples: pcm.length };
}

function toWav(x, sr) {
  const b = new ArrayBuffer(44 + x.length * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + 2 * i, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return b;
}
