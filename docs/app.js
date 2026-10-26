import { Fusion, Drivetrain, SimCar, DEFAULTS, TRANSMISSIONS, G } from './vehicle.js?v=8';
import { Obd, clean } from './obd.js?v=8';
import { Recorder, DrivesView, store, normalizeImport, exportDrive } from './drives.js?v=8';
import { uploadCfg, saveUploadCfg, syncDrives, uploadDrive } from './upload.js?v=8';

const $ = (id) => document.getElementById(id);
const VERSION = '8';   // bump with each release (also in index.html and the imports above)

// ------------------------------------------------------------------ settings
const SETTINGS_KEY = 'v8drive.settings';
const UI_DEFAULTS = { vol: 1.0, pitch: 1.0, autoRec: true };
const SETTINGS_VERSION = 5;   // v5: back to one engine (Mustang GT500 + Chrysler idle), pitch A/B
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
let savedCfg = null;
function saveSettings() {
  // changes made mid-drive go into the log, so the analysis knows which settings each part used
  for (const k in cfg) if (savedCfg && savedCfg[k] !== cfg[k] && k !== 'idleRpm') recorder.note(performance.now() / 1000, 'set', k, cfg[k]);
  savedCfg = { ...cfg };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
}
const cfg = { ...DEFAULTS, ...UI_DEFAULTS, ...loadSettings() };
if ((cfg.version || 0) < 3) cfg.idle = UI_DEFAULTS.idle;
if ((cfg.version || 0) < 4) delete cfg.downMode;
if ((cfg.version || 0) < 5) cfg.version = SETTINGS_VERSION;
for (const k of ['mode', 'engine', 'idle', 'idleByEngine', 'lowSpeed', 'pitchMode']) delete cfg[k];
savedCfg = { ...cfg };

// ------------------------------------------------------------------ state
const fusion = new Fusion(cfg);
const drive = new Drivetrain(cfg);
const sim = new SimCar();
let simPedal = 0, simRegen = 1, simBrake = 0;
let ctx = null, node = null, master = null;
let banks = null;
const recorder = new Recorder();
let drivesView = null;
let lastEventN = 0;
let running = false;
let tickTimer = null, lastTick = 0;
let motionCount = 0, motionRate = 0, motionT0 = 0, lastMotion = 0;
let gpsInfo = null, gpsWatch = null;
let lastSim = null;
let wakeLock = null;
let obd = null;

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

// One engine: Mustang GT500 loop bank + Chrysler idle (the pairing chosen in v3).
async function loadBanks() {
  let got = 0;
  const total = 2.9e6;
  const prog = (b) => { got += b; $('startBtn').textContent = `Loading sounds… ${Math.min(99, Math.round(got / total * 100))}%`; };
  const [bank, idleList] = await Promise.all([
    fetch('audio/bankA.json?v=' + VERSION).then((r) => r.json()),
    fetch('audio/idles.json?v=' + VERSION).then((r) => r.json()),
  ]);
  const idle = idleList.idles.find((v) => v.id === 'I3');
  const [bw, iw] = await Promise.all([
    fetchProgress('audio/bankA.wav?v=' + VERSION, prog),
    fetchProgress('audio/' + idle.file + '?v=' + VERSION, prog),
  ]);
  bank.data = parseWav(bw).data;
  idle.data = parseWav(iw).data;
  idle.sr = idleList.sr;
  return { bank, idle };
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
  await ctx.audioWorklet.addModule('engine-worklet.js?v=' + VERSION);
  node = new AudioWorkletNode(ctx, 'v8-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  master = ctx.createGain();
  master.gain.value = cfg.vol;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.15;
  node.connect(master).connect(comp).connect(ctx.destination);
  const { bank, idle } = banks;
  node.port.postMessage({ type: 'bank', sr: bank.sr, loops: bank.loops, data: bank.data });
  node.port.postMessage({ type: 'idle', sr: idle.sr, rpm: idle.rpm, data: idle.data, length: idle.data.length - 2 });
  ctx.onstatechange = () => updateChips();
}

// ------------------------------------------------------------------ sensors
function onMotion(e) {
  const t = performance.now() / 1000;
  const acc = e.acceleration, ag = e.accelerationIncludingGravity;
  const a = acc && acc.x != null ? [acc.x, acc.y, acc.z] : null;
  const g = ag && ag.x != null ? [ag.x, ag.y, ag.z] : null;
  fusion.motion(t, a, g, e.rotationRate);
  recorder.motion(t, a, g, e.rotationRate);
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
    recorder.gps(now, c, now - tFix);
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
  if (cfg.autoRec && !recorder.active) {
    recorder.start({ engine: 'gt500', sim: $('simOn').checked, settings: { ...cfg } });
  }
  btn.disabled = false; btn.textContent = 'Stop'; btn.classList.add('stop');
}

function stop() {
  running = false;
  recorder.stop().then(() => sync()).then(() => drivesView && drivesView.refresh());
  sendState(true);
  const btn = $('startBtn');
  btn.textContent = 'Start engine'; btn.classList.remove('stop');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

window.addEventListener('pagehide', () => { recorder.flush(); });
document.addEventListener('visibilitychange', () => {
  recorder.note(performance.now() / 1000, document.visibilityState);
  if (document.visibilityState === 'hidden') recorder.flush();   // iOS may suspend the page any moment
  if (document.visibilityState === 'visible' && !running) sync();
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
    sim.step(simPedal, simBrake, dt, simRegen);
    v = sim.v; a = aq = sim.a;
  } else {
    v = fusion.v; a = fusion.aLongF; aq = fusion.aLongQ;
  }
  drive.update(v, aq, dt, a);
  sendState(false);
  if ($('simOn').checked !== lastSim) { lastSim = $('simOn').checked; recorder.note(now, 'sim', lastSim ? 1 : 0); }
  if (recorder.active) {
    recorder.row(now, v, a, $('simOn').checked ? a : fusion.aLong, drive, aq);
    if (drive.events.length !== lastEventN || drive.events[drive.events.length - 1] !== recorder.lastEv) {
      const e = drive.events[drive.events.length - 1];
      if (e && e !== recorder.lastEv) { recorder.event(now, e); recorder.lastEv = e; }
      lastEventN = drive.events.length;
    }
  }
  ui.v = v; ui.a = a;
}

function sendState(silence) {
  if (!node) return;
  const on = running && !silence;
  node.port.postMessage({
    type: 'state', rpm: drive.rpm, pitch: cfg.pitch, load: drive.load, gain: on ? 0.72 + 0.38 * drive.load : 0,
  });
}

// ------------------------------------------------------------------ UI
const ui = { v: 0, a: 0 };
const tach = $('tach'), tc = tach.getContext('2d');
const RPM_MAX = 7000;

function drawTach() {
  const W = tach.width, H = tach.height, cx = W / 2, cy = H * 0.9, R = W * 0.42;
  const a0 = Math.PI * 0.92, a1 = Math.PI * 2.08;
  const ang = (r) => a0 + (a1 - a0) * Math.min(1, r / RPM_MAX);
  tc.clearRect(0, 0, W, H);
  tc.lineCap = 'round';
  tc.lineWidth = 26; tc.strokeStyle = '#22262c';
  tc.beginPath(); tc.arc(cx, cy, R, a0, a1); tc.stroke();
  tc.strokeStyle = '#5a1f1f';
  tc.beginPath(); tc.arc(cx, cy, R, ang(6500), a1); tc.stroke();
  const grad = tc.createLinearGradient(cx - R, 0, cx + R, 0);
  grad.addColorStop(0, '#ffb020'); grad.addColorStop(1, '#ff3d1f');
  tc.strokeStyle = grad;
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

function bindRange(id, fmt, onChange) {
  const el = $(id), out = $(id + 'O');
  el.value = cfg[id];
  const show = () => { out.textContent = fmt(+el.value); };
  show();
  el.addEventListener('input', () => { cfg[id] = +el.value; show(); saveSettings(); onChange && onChange(); });
}

function bindCheck(id, onChange) {
  const el = $(id);
  el.checked = !!cfg[id];
  el.addEventListener('change', () => { cfg[id] = el.checked; saveSettings(); onChange && onChange(); });
}

// one tap while driving: what you heard right now, so the analysis can look at that moment
function mark(what) {
  if (!recorder.active) { $('loadInfo').textContent = 'Start the engine first: marks go into the drive log.'; return; }
  const now = performance.now() / 1000;
  recorder.note(now, 'mark', what, Math.round(drive.rpm), drive.gear, +(ui.v * 3.6).toFixed(1));
  const t = Math.round(now - recorder.t0);
  $('markInfo').textContent = `Marked "${what}" at ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} · ${Math.round(ui.v * 3.6)} km/h, gear ${drive.gear}, ${Math.round(drive.rpm)} rpm`;
  const b = $(what === 'wrong' ? 'markBad' : 'markGood');
  b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 600);
}

function sync() {
  return syncDrives(VERSION, recorder.active ? recorder.id : null)
    .then((s) => { $('upStatus').textContent = s; drivesView && drivesView.refresh(); })
    .catch((e) => { $('upStatus').textContent = 'Upload failed: ' + e.message; });
}

function initUpload() {
  const c = uploadCfg();
  $('upOn').checked = c.on; $('upRepo').value = c.repo; $('upToken').value = c.token;
  const save = () => saveUploadCfg({ on: $('upOn').checked, repo: $('upRepo').value.trim(), token: $('upToken').value.trim() });
  $('upOn').addEventListener('change', () => { save(); sync(); });
  $('upRepo').addEventListener('change', save);
  $('upToken').addEventListener('change', save);
  $('upNow').addEventListener('click', () => { save(); $('upStatus').textContent = 'Uploading…'; sync(); });
  $('driveUpload').addEventListener('click', async () => {
    if (!drivesView || !drivesView.drive) return;
    $('driveUpInfo').textContent = 'Uploading…';
    try {
      const r = await uploadDrive(drivesView.drive.id, VERSION);
      $('driveUpInfo').textContent = `Uploaded ${r.name} (${(r.bytes / 1e6).toFixed(1)} MB)`;
      drivesView.drive.uploaded = r.name;
      drivesView.refresh();
    } catch (e) { $('driveUpInfo').textContent = e.message; }
  });
  // share sheet (AirDrop, Mail, Files...): the file is built when the drive opens, because
  // Safari only allows sharing straight from the tap
  $('driveShare').addEventListener('click', () => {
    const f = drivesView && drivesView.shareFile;
    if (!f) { $('driveUpInfo').textContent = 'Preparing the file, tap again in a second'; return; }
    if (navigator.canShare && navigator.canShare({ files: [f] })) navigator.share({ files: [f], title: f.name }).catch(() => {});
    else exportDrive(drivesView.drive, VERSION);
  });
}

function showPage(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.id !== id));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === id));
  if (id === 'drivesPage') {
    if (!drivesView) drivesView = new DrivesView($('drivesPage'), () => cfg, VERSION);
    drivesView.refresh();
    if (drivesView.drive) drivesView.renderMap().then(() => drivesView.map && drivesView.map.invalidateSize());
  }
}

// The previous release stays playable at prev/ (tools/release.sh), one tap away.
function initVersion() {
  const a = $('verLink');
  a.textContent = 'v' + VERSION;
  const inPrev = /\/prev\/(index\.html)?$/.test(location.pathname);
  fetch((inPrev ? '../' : '') + 'versions.json', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (inPrev) { a.href = '../'; a.textContent = `v${VERSION} (previous) · back to v${j.current}`; }
    else if (j.prev) { a.href = 'prev/'; a.textContent = `v${VERSION} · try v${j.prev}`; }
  }).catch(() => {});
}

function initUI() {
  initVersion();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.p)));
  bindCheck('autoRec');
  document.querySelectorAll('.metricBtn').forEach((b) => b.addEventListener('click', () => drivesView && drivesView.setMetric(b.dataset.m)));
  $('driveExport').addEventListener('click', () => drivesView && drivesView.drive && exportDrive(drivesView.drive, VERSION));
  $('markBad').addEventListener('click', () => mark('wrong'));
  $('markGood').addEventListener('click', () => mark('great'));
  initUpload();
  $('driveDelete').addEventListener('click', () => { if (drivesView && drivesView.drive && confirm('Delete this drive?')) drivesView.remove(); });
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = normalizeImport(JSON.parse(await f.text()));
      const id = await store.importDrive(d);
      if (!drivesView) drivesView = new DrivesView($('drivesPage'), () => cfg, VERSION);
      await drivesView.open(id);
    } catch (err) { alert('Import failed: ' + err.message); }
    e.target.value = '';
  });
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
  bindRange('gMax', (x) => x.toFixed(2) + ' g');
  bindRange('downRpm', (x) => x + ' rpm');
  bindCheck('downFollow');
  const sm = $('sportMinRpm'), smO = $('sportMinRpmO');
  sm.value = cfg.sportMinRpm || 1500;
  const smShow = () => { smO.textContent = +sm.value < 2000 ? 'Off' : sm.value + ' rpm'; };
  smShow();
  sm.addEventListener('input', () => { cfg.sportMinRpm = +sm.value < 2000 ? 0 : +sm.value; smShow(); saveSettings(); });
  bindRange('sportBelowKmh', (x) => x + ' km/h');
  bindRange('loadFullG', (x) => x.toFixed(2) + ' g');
  bindRange('gpsLatency', (x) => x.toFixed(2) + ' s');
  $('recal').addEventListener('click', () => { fusion.reset(); updateChips(); });
  $('resetCfg').addEventListener('click', () => {
    try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
    location.reload();
  });

  // simulator pedals
  const pedal = $('pedal');
  // bottom 20% of the pedal = lift-off zone: regen from none (at the line) to level 3 (bottom)
  const setPedal = (e) => {
    const r = pedal.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
    simPedal = p > 0.2 ? (p - 0.2) / 0.8 : 0;
    simRegen = p < 0.2 ? (0.2 - p) / 0.2 : 0;
    $('pedalFill').style.height = (p * 100) + '%';
    $('pedalFill').classList.toggle('regen', p < 0.2);
    $('pedalTxt').innerHTML = p >= 0.2 ? `Throttle ${Math.round(simPedal * 100)}%` : `Regen ${Math.round(simRegen * 100)}%`;
  };
  pedal.addEventListener('pointerdown', (e) => { pedal.setPointerCapture(e.pointerId); setPedal(e); if (!$('simOn').checked) $('simOn').checked = true; });
  pedal.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') setPedal(e); });
  const release = () => { simPedal = 0; simRegen = 1; $('pedalFill').style.height = '0'; $('pedalTxt').innerHTML = 'Foot off · regen 3<br>drag up to accelerate'; };
  pedal.addEventListener('pointerup', release); pedal.addEventListener('pointercancel', release);
  const brake = $('brake');
  brake.addEventListener('pointerdown', (e) => { brake.setPointerCapture(e.pointerId); simBrake = 1; brake.classList.add('on'); });
  const bUp = () => { simBrake = 0; brake.classList.remove('on'); };
  brake.addEventListener('pointerup', bUp); brake.addEventListener('pointercancel', bUp);

  // OBD2
  if (Obd.available()) { $('obdNo').classList.add('hidden'); $('obdYes').classList.remove('hidden'); }
  const olog = (s) => { const p = $('obdlog'); p.textContent += s + '\n'; p.scrollTop = p.scrollHeight; };
  $('obdConnect').addEventListener('click', async () => {
    try {
      obd = new Obd(olog);
      obd.onSpeed = (v, t) => { fusion.obd(t, v); recorder.note(t, 'obd', +v.toFixed(2)); };
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
  cfg.idleRpm = b.idle.rpm;
  drive.rpm = Math.max(drive.rpm, cfg.idleRpm * 0.95);
  $('engineSub').textContent = 'Ford Mustang GT500 V8 · EV sound';
  $('startBtn').disabled = false;
  $('startBtn').textContent = 'Start engine';
}).catch((e) => { $('startBtn').textContent = 'Failed to load sounds'; $('loadInfo').textContent = e.message; });
sync();   // finish and upload drives from earlier sessions

// test hook for automated checks
window.__v8 = { sync, mark, cfg, fusion, drive, sim, get node() { return node; }, get ctx() { return ctx; }, get banks() { return banks; }, recorder, get drivesView() { return drivesView; }, store, setPedal: (p, r = p > 0 ? 0 : 1) => { simPedal = p; simRegen = r; }, setBrake: (b) => { simBrake = b; } };
