import { Fusion, Drivetrain, SimCar, DEFAULTS, TRANSMISSIONS, G } from './vehicle.js';
import { Obd, clean } from './obd.js';

const $ = (id) => document.getElementById(id);
const MODE_INFO = {
  A: 'A · Loop bank: phase-aligned constant-RPM loops, crossfaded',
  B: 'B · Granular replay: the real recording, cycle by cycle',
};

// ------------------------------------------------------------------ settings
const SETTINGS_KEY = 'v8drive.settings.v1';
const UI_DEFAULTS = { vol: 1.0, pitch: 1.0, mode: 'A' };
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
}
const cfg = { ...DEFAULTS, ...UI_DEFAULTS, ...loadSettings() };
const hashMode = location.hash.replace('#', '').toUpperCase();
if (hashMode === 'A' || hashMode === 'B') cfg.mode = hashMode;

// ------------------------------------------------------------------ state
const fusion = new Fusion(cfg);
const drive = new Drivetrain(cfg);
const sim = new SimCar();
let simPedal = 0, simBrake = 0;
let ctx = null, node = null, master = null;
let banks = null;
let running = false;
let tickTimer = null, lastTick = 0;
let motionCount = 0, motionRate = 0, motionT0 = 0, lastMotion = 0;
let gpsInfo = null, gpsWatch = null;
let wakeLock = null;
let obd = null;
const log = { on: false, rows: [], gps: [], t0: 0 };

// ------------------------------------------------------------------ banks
function parseWav(buf) {
  const dv = new DataView(buf);
  let p = 12, sr = 0, data = null;
  while (p < dv.byteLength - 8) {
    const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    const len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') sr = dv.getUint32(p + 12, true);
    if (id === 'data') {
      const n = len >> 1;
      data = new Float32Array(n + 2);
      for (let i = 0; i < n; i++) data[i] = dv.getInt16(p + 8 + 2 * i, true) / 32768;
    }
    p += 8 + len + (len & 1);
  }
  return { sr, data };
}

async function fetchProgress(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!r.body || !r.body.getReader) return r.arrayBuffer();
  const reader = r.body.getReader(); const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length; onBytes(value.length);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

async function loadBanks() {
  let got = 0;
  const total = 5.5e6;
  const prog = (b) => { got += b; $('startBtn').textContent = `Loading sounds… ${Math.min(99, Math.round(got / total * 100))}%`; };
  const [aj, bj, aw, bw] = await Promise.all([
    fetch('audio/bankA.json').then((r) => r.json()),
    fetch('audio/bankB.json').then((r) => r.json()),
    fetchProgress('audio/bankA.wav', prog),
    fetchProgress('audio/bankB.wav', prog),
  ]);
  return { A: { ...aj, data: parseWav(aw).data }, B: { ...bj, data: parseWav(bw).data } };
}

// ------------------------------------------------------------------ audio
function unlockSilentAudio() {
  // Puts iOS audio in "playback" so the ring/silent switch doesn't mute the engine.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older iOS */ }
  try {
    const sr = 8000, n = sr / 2, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    const a = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
    a.loop = true; a.setAttribute('playsinline', ''); a.play().catch(() => {});
  } catch (e) { /* ignore */ }
}

async function startAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const resumed = ctx.resume();
  await resumed;
  await ctx.audioWorklet.addModule('engine-worklet.js');
  node = new AudioWorkletNode(ctx, 'v8-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  master = ctx.createGain();
  master.gain.value = cfg.vol;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.15;
  node.connect(master).connect(comp).connect(ctx.destination);
  const a = banks.A, b = banks.B;
  node.port.postMessage({ type: 'bankA', sr: a.sr, loops: a.loops, data: a.data });
  node.port.postMessage({ type: 'bankB', sr: b.sr, frame: b.frame, segments: b.segments, data: b.data });
  ctx.onstatechange = () => updateChips();
}

// ------------------------------------------------------------------ sensors
function onMotion(e) {
  const t = performance.now() / 1000;
  const acc = e.acceleration, ag = e.accelerationIncludingGravity;
  const a = acc && acc.x != null ? [acc.x, acc.y, acc.z] : null;
  const g = ag && ag.x != null ? [ag.x, ag.y, ag.z] : null;
  fusion.motion(t, a, g, e.rotationRate);
  motionCount++; lastMotion = t;
  if (t - motionT0 > 1) { motionRate = motionCount / (t - motionT0); motionCount = 0; motionT0 = t; }
}

function startGps() {
  if (!navigator.geolocation) return;
  gpsWatch = navigator.geolocation.watchPosition((pos) => {
    const now = performance.now() / 1000;
    const tFix = Math.min(now, now - (Date.now() - pos.timestamp) / 1000);
    const c = pos.coords;
    gpsInfo = { t: now, acc: c.accuracy, speed: c.speed };
    fusion.gps(tFix, c.speed, c.accuracy);
    if (log.on) log.gps.push([+(now - log.t0).toFixed(3), c.speed, Math.round(c.accuracy), c.heading]);
  }, (err) => { gpsInfo = { err: err.message }; updateChips(); },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
}

// ------------------------------------------------------------------ start / stop
async function start() {
  const btn = $('startBtn');
  btn.disabled = true;
  unlockSilentAudio();
  // iOS: permission prompts must be triggered directly from the tap
  let motionPerm = Promise.resolve('granted');
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    motionPerm = DeviceMotionEvent.requestPermission().catch(() => 'denied');
  }
  if (!gpsWatch) startGps();
  try {
    if (!ctx) await startAudio(); else await ctx.resume();
  } catch (e) {
    $('loadInfo').textContent = 'Audio failed to start: ' + e.message;
    btn.disabled = false;
    return;
  }
  const mp = await motionPerm;
  if (mp === 'granted') window.addEventListener('devicemotion', onMotion);
  else $('loadInfo').textContent = 'Motion access denied. Use the simulator, or allow Motion & Orientation access in Safari settings.';
  requestWakeLock();
  running = true;
  btn.disabled = false; btn.textContent = 'Stop'; btn.classList.add('stop');
}

function stop() {
  running = false;
  sendState(true);
  const btn = $('startBtn');
  btn.textContent = 'Start engine'; btn.classList.remove('stop');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) {
    if (ctx && ctx.state !== 'running') ctx.resume();
    requestWakeLock();
  }
});

// ------------------------------------------------------------------ main loop
function tick() {
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, Math.max(0.001, now - (lastTick || now - 1 / 60)));
  lastTick = now;
  let v, a, aq;
  if ($('simOn').checked) {
    sim.step(simPedal, simBrake, dt);
    v = sim.v; a = aq = sim.a;
  } else {
    v = fusion.v; a = fusion.aLongF; aq = fusion.aLongQ;
  }
  drive.update(v, aq, dt, a);
  sendState(false);
  if (log.on) logRow(now, v, a);
  ui.v = v; ui.a = a;
}

function sendState(silence) {
  if (!node) return;
  const on = running && !silence;
  node.port.postMessage({
    type: 'state', mode: cfg.mode,
    rpm: drive.rpm * cfg.pitch, rate: drive.rate * cfg.pitch,
    load: drive.load, gain: on ? 0.72 + 0.38 * drive.load : 0,
  });
}

let lastLog = 0;
function logRow(now, v, a) {
  if (now - lastLog < 0.04) return;
  lastLog = now;
  const f = fusion;
  log.rows.push([+(now - log.t0).toFixed(3), +v.toFixed(3), +a.toFixed(3), +f.aLong.toFixed(3),
    Math.round(drive.rpm), drive.gear, +drive.load.toFixed(2), +drive.aggr.toFixed(3),
    f.g ? f.g.map((x) => +x.toFixed(2)) : null, f.fwd ? f.fwd.map((x) => +x.toFixed(3)) : null,
    f.handling ? 1 : 0, +f.bias.toFixed(3)]);
  if (log.rows.length % 250 === 0) $('logInfo').textContent = `Recording · ${log.rows.length} rows · ${log.gps.length} GPS fixes`;
}

// ------------------------------------------------------------------ UI
const ui = { v: 0, a: 0 };
const tach = $('tach'), tc = tach.getContext('2d');
const RPM_MAX = 6000;

function drawTach() {
  const W = tach.width, H = tach.height, cx = W / 2, cy = H * 0.9, R = W * 0.42;
  const a0 = Math.PI * 0.92, a1 = Math.PI * 2.08;
  const ang = (r) => a0 + (a1 - a0) * Math.min(1, r / RPM_MAX);
  tc.clearRect(0, 0, W, H);
  tc.lineCap = 'round';
  tc.lineWidth = 26; tc.strokeStyle = '#22262c';
  tc.beginPath(); tc.arc(cx, cy, R, a0, a1); tc.stroke();
  tc.strokeStyle = '#5a1f1f';
  tc.beginPath(); tc.arc(cx, cy, R, ang(5500), a1); tc.stroke();
  const grad = tc.createLinearGradient(cx - R, 0, cx + R, 0);
  grad.addColorStop(0, '#ffb020'); grad.addColorStop(1, '#ff3d1f');
  tc.strokeStyle = cfg.mode === 'A' ? '#4aa8ff' : grad;
  tc.beginPath(); tc.arc(cx, cy, R, a0, ang(drive.rpm)); tc.stroke();
  // ticks
  tc.fillStyle = '#8b929c'; tc.font = '600 30px -apple-system, system-ui, sans-serif'; tc.textAlign = 'center'; tc.textBaseline = 'middle';
  for (let r = 0; r <= RPM_MAX; r += 1000) {
    const t = ang(r), x = cx + Math.cos(t) * (R - 52), y = cy + Math.sin(t) * (R - 52);
    tc.fillText(String(r / 1000), x, y);
  }
  // shift-point marker
  const sp = drive.shiftPoint(), ts = ang(sp);
  tc.strokeStyle = '#fff'; tc.lineWidth = 6;
  tc.beginPath(); tc.moveTo(cx + Math.cos(ts) * (R - 20), cy + Math.sin(ts) * (R - 20)); tc.lineTo(cx + Math.cos(ts) * (R + 20), cy + Math.sin(ts) * (R + 20)); tc.stroke();
  // rpm digits
  tc.fillStyle = '#eef0f3'; tc.font = '700 120px -apple-system, system-ui, sans-serif';
  tc.fillText(String(Math.round(drive.rpm / 10) * 10), cx, cy - R * 0.38);
  tc.fillStyle = '#8b929c'; tc.font = '600 28px -apple-system, system-ui, sans-serif';
  tc.fillText('RPM', cx, cy - R * 0.1);
}

function render() {
  drawTach();
  $('gear').textContent = drive.shift ? '·' : (ui.v < 0.5 && drive.load < 0.15 ? 'N' : drive.gear);
  $('spd').textContent = Math.round(ui.v * 3.6);
  $('shiftAt').textContent = Math.round(drive.shiftPoint() / 50) * 50;
  $('loadBar').style.width = (drive.load * 100).toFixed(0) + '%';
  $('loadTxt').textContent = (drive.load * 100).toFixed(0) + '%';
  const g = ui.a / G;
  $('accBar').style.width = Math.min(100, Math.abs(g) / 0.5 * 100).toFixed(0) + '%';
  $('accTxt').textContent = (g >= 0 ? '+' : '') + g.toFixed(2) + ' g';
  requestAnimationFrame(render);
}

function chip(id, cls, text) { const el = $(id); el.className = 'chip ' + cls; el.textContent = text; }
function updateChips() {
  const now = performance.now() / 1000;
  chip('cAudio', ctx && ctx.state === 'running' && running ? 'ok' : (ctx ? 'warn' : ''), ctx ? `Audio ${ctx.state === 'running' ? Math.round((ctx.baseLatency || 0) * 1000 + (ctx.outputLatency || 0) * 1000) + ' ms' : ctx.state}` : 'Audio');
  if (lastMotion && now - lastMotion < 1) chip('cMotion', fusion.handling ? 'warn' : 'ok', `Motion ${Math.round(motionRate)} Hz${fusion.handling ? ' (moving phone)' : ''}`);
  else chip('cMotion', running ? 'bad' : '', 'Motion');
  if (gpsInfo && gpsInfo.err) chip('cGps', 'bad', 'GPS denied');
  else if (gpsInfo && now - gpsInfo.t < 3) chip('cGps', gpsInfo.acc < 20 ? 'ok' : 'warn', `GPS ±${Math.round(gpsInfo.acc)} m`);
  else chip('cGps', running ? 'warn' : '', 'GPS');
  const fs = { none: ['', 'Direction'], preset: ['warn', 'Direction: assumed'], launch: ['ok', 'Direction: learned'], gps: ['ok', 'Direction: GPS-locked'] }[fusion.fwdSource];
  chip('cFwd', fs[0], fs[1]);
  $('fwdInfo').textContent = { none: 'Learns on first pull-away', preset: 'Assumed: screen faces you. Learns on first pull-away.', launch: 'Learned from your pull-away', gps: 'Locked using GPS' }[fusion.fwdSource];
  if (obd && obd.polling) chip('cObd', 'ok', `OBD2 ${obd.rateHz.toFixed(1)} Hz`);
}

function setMode(m) {
  cfg.mode = m; saveSettings();
  document.querySelectorAll('.ab button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  $('modeinfo').textContent = MODE_INFO[m];
  history.replaceState(null, '', '#' + m);
  sendState(!running);
}

function bindRange(id, fmt, onChange) {
  const el = $(id), out = $(id + 'O');
  el.value = cfg[id];
  const show = () => { out.textContent = fmt(+el.value); };
  show();
  el.addEventListener('input', () => { cfg[id] = +el.value; show(); saveSettings(); onChange && onChange(); });
}

function initUI() {
  document.querySelectorAll('.ab button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
  setMode(cfg.mode);
  $('startBtn').addEventListener('click', () => (running ? stop() : start()));
  const sel = $('trans');
  for (const [k, t] of Object.entries(TRANSMISSIONS)) sel.add(new Option(t.name, k));
  sel.value = cfg.trans;
  sel.addEventListener('change', () => { cfg.trans = sel.value; drive.setTransmission(sel.value); saveSettings(); });
  bindRange('vol', (x) => Math.round(x * 100) + '%', () => master && master.gain.setTargetAtTime(cfg.vol, ctx.currentTime, 0.05));
  bindRange('pitch', (x) => x.toFixed(2) + '×');
  bindRange('gSlow', (x) => x.toFixed(2) + ' g');
  bindRange('gMed', (x) => x.toFixed(2) + ' g');
  bindRange('gFast', (x) => x.toFixed(2) + ' g');
  bindRange('loadFullG', (x) => x.toFixed(2) + ' g');
  bindRange('gpsLatency', (x) => x.toFixed(2) + ' s');
  $('recal').addEventListener('click', () => { fusion.reset(); updateChips(); });
  $('resetCfg').addEventListener('click', () => {
    try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
    location.reload();
  });

  // simulator pedals
  const pedal = $('pedal');
  const setPedal = (e) => {
    const r = pedal.getBoundingClientRect();
    simPedal = Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
    $('pedalFill').style.height = (simPedal * 100) + '%';
    $('pedalTxt').innerHTML = Math.round(simPedal * 100) + '%';
  };
  pedal.addEventListener('pointerdown', (e) => { pedal.setPointerCapture(e.pointerId); setPedal(e); if (!$('simOn').checked) $('simOn').checked = true; });
  pedal.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') setPedal(e); });
  const release = () => { simPedal = 0; $('pedalFill').style.height = '0'; $('pedalTxt').innerHTML = 'Accelerator<br>drag up'; };
  pedal.addEventListener('pointerup', release); pedal.addEventListener('pointercancel', release);
  const brake = $('brake');
  brake.addEventListener('pointerdown', (e) => { brake.setPointerCapture(e.pointerId); simBrake = 1; brake.classList.add('on'); });
  const bUp = () => { simBrake = 0; brake.classList.remove('on'); };
  brake.addEventListener('pointerup', bUp); brake.addEventListener('pointercancel', bUp);

  // drive log
  $('logOn').addEventListener('change', (e) => {
    log.on = e.target.checked;
    if (log.on) { log.rows = []; log.gps = []; log.t0 = performance.now() / 1000; $('logInfo').textContent = 'Recording…'; }
    else $('logInfo').textContent = `Stopped · ${log.rows.length} rows`;
  });
  $('logExport').addEventListener('click', () => {
    const d = new Date();
    const name = `v8drive-${d.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
    const payload = {
      app: 'v8drive', version: 1, started: new Date(Date.now() - (performance.now() / 1000 - log.t0) * 1000).toISOString(),
      settings: cfg, ua: navigator.userAgent,
      columns: ['t', 'v', 'aUsed', 'aLongRaw', 'rpm', 'gear', 'load', 'aggr', 'gravity', 'fwd', 'handling', 'bias'],
      gpsColumns: ['t', 'speed', 'acc', 'heading'], rows: log.rows, gps: log.gps, shifts: drive.events,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  // OBD2
  if (Obd.available()) { $('obdNo').classList.add('hidden'); $('obdYes').classList.remove('hidden'); }
  const olog = (s) => { const p = $('obdlog'); p.textContent += s + '\n'; p.scrollTop = p.scrollHeight; };
  $('obdConnect').addEventListener('click', async () => {
    try {
      obd = new Obd(olog);
      obd.onSpeed = (v, t) => fusion.obd(t, v);
      await obd.connect($('obdInit').value.split(';').map((s) => s.trim()).filter(Boolean));
      $('obdInfo').textContent = 'Connected · polling speed (010D)';
      obd.poll();
    } catch (e) { olog('Error: ' + e.message); }
  });
  $('obdSend').addEventListener('click', async () => {
    if (!obd || !obd.tx) return olog('Not connected');
    const cmd = $('obdCmd').value.trim(); if (!cmd) return;
    const was = obd.polling; obd.polling = false;
    await new Promise((r) => setTimeout(r, 300));
    olog(`${cmd} → ${clean(await obd.send(cmd, 3000))}`);
    if (was) obd.poll();
  });
}

// ------------------------------------------------------------------ boot
initUI();
requestAnimationFrame(render);
tickTimer = setInterval(tick, 1000 / 60);
setInterval(updateChips, 500);
updateChips();
loadBanks().then((b) => {
  banks = b;
  $('startBtn').disabled = false;
  $('startBtn').textContent = 'Start engine';
}).catch((e) => { $('startBtn').textContent = 'Failed to load sounds'; $('loadInfo').textContent = e.message; });

// test hook for automated checks
window.__v8 = { cfg, fusion, drive, sim, get node() { return node; }, get ctx() { return ctx; }, get banks() { return banks; }, setPedal: (p) => { simPedal = p; }, setBrake: (b) => { simBrake = b; } };
