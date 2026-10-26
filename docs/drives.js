// Drive recording (IndexedDB on the phone), upload for analysis, and the Drives tab:
// map + charts + stats.
// Map: Leaflet with OpenStreetMap tiles (darkened with a CSS filter); no API key.
// Drives leave the phone only if the user turns on upload (to their own private GitHub repo)
// or sends one from the Drives tab.

const DB = 'v8drive', VER = 1;
// rows (25 Hz): fused speed, aLongF (a), raw aLong, rpm, gear, load, aggression, aLongQ (aq:
// what the drivetrain's load used), shift (1 while a gear change is in progress)
const ROW_COLS = ['t', 'v', 'a', 'aRaw', 'rpm', 'gear', 'load', 'aggr', 'aq', 'shift'];
// gps: age = how old the fix was when it arrived (s)
const GPS_COLS = ['t', 'lat', 'lon', 'speed', 'acc', 'heading', 'age'];
// motion (every devicemotion event): linear accel, accel incl. gravity, rotation rate (deg/s)
const MOTION_COLS = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'ra', 'rb', 'rg'];
// events: [t, kind, ...]: up/down/kickdown (from, to, rpm), mark (what), set (key, value),
// sim (on), obd (speed m/s), hidden/visible (page backgrounded), stop
export const LOG_VERSION = 3;

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('drives')) d.createObjectStore('drives', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (db, stores, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(stores, mode);
  const out = fn(t);
  t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
  t.onerror = () => rej(t.error);
});

export const store = {
  async list() {
    const db = await idb();
    const req = await tx(db, ['drives'], 'readonly', (t) => t.objectStore('drives').getAll());
    return (req || []).sort((a, b) => b.startedMs - a.startedMs);
  },
  async putMeta(meta) { const db = await idb(); await tx(db, ['drives'], 'readwrite', (t) => t.objectStore('drives').put(meta)); },
  async putChunk(c) { const db = await idb(); await tx(db, ['chunks'], 'readwrite', (t) => t.objectStore('chunks').put(c)); },
  async load(id) {
    const db = await idb();
    const meta = await tx(db, ['drives'], 'readonly', (t) => t.objectStore('drives').get(id));
    const chunks = await tx(db, ['chunks'], 'readonly',
      (t) => t.objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
    const d = { ...meta, rows: [], gps: [], events: [], motion: [] };
    for (const c of (chunks || []).sort((a, b) => a.seq - b.seq)) {
      for (const r of c.rows) d.rows.push(r);
      for (const g of c.gps) d.gps.push(g);
      for (const e of c.events) d.events.push(e);
      if (c.motion && !(c.motion instanceof Float32Array)) for (const m of c.motion) d.motion.push(m);
      else if (c.motion) {
        const m = c.motion, n = MOTION_COLS.length;
        for (let i = 0; i + n <= m.length; i += n) {
          const r = [+m[i].toFixed(3)];
          for (let k = 1; k < n; k++) r.push(+m[i + k].toFixed(k < 7 ? 3 : 1));
          d.motion.push(r);
        }
      }
    }
    return d;
  },
  async remove(id) {
    const db = await idb();
    await tx(db, ['drives', 'chunks'], 'readwrite', (t) => {
      t.objectStore('drives').delete(id);
      t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    });
  },
  async importDrive(d) {
    const id = d.id || ('imp-' + Date.now());
    const meta = summarize({ ...d, id });
    await this.putMeta(meta);
    await this.putChunk({ id, seq: 0, rows: d.rows || [], gps: d.gps || [], events: d.events || [], motion: d.motion || [] });
    return id;
  },
};

// ------------------------------------------------------------------ recorder

export class Recorder {
  constructor() { this.active = false; }

  start(info) {
    const now = Date.now();
    this.id = 'd' + now;
    this.t0 = performance.now() / 1000;
    this.seq = 0;
    this.buf = { rows: [], gps: [], events: [], motion: [] };
    this.meta = { id: this.id, startedMs: now, started: new Date(now).toISOString(), columns: ROW_COLS,
      gpsColumns: GPS_COLS, motionColumns: MOTION_COLS, device: navigator.userAgent, ...info,
      rowsN: 0, gpsN: 0, gpsMaxKmh: 0, marks: 0, durationS: 0, distanceM: 0, maxKmh: 0, maxG: 0, minG: 0, ended: false };
    this.lastFix = null;
    this.lastRow = 0;
    this.active = true;
    this.timer = setInterval(() => this.flush(), 15000);
  }

  row(now, v, a, aRaw, drive, aq = 0) {
    if (!this.active || now - this.lastRow < 0.04) return;
    this.lastRow = now;
    const t = +(now - this.t0).toFixed(3);
    this.buf.rows.push([t, +v.toFixed(2), +a.toFixed(3), +aRaw.toFixed(3), Math.round(drive.rpm), drive.gear,
      +drive.load.toFixed(2), +drive.aggr.toFixed(3), +aq.toFixed(3), drive.shift ? 1 : 0]);
    const m = this.meta;
    m.rowsN++; m.durationS = t;
    m.maxKmh = Math.max(m.maxKmh, v * 3.6);
    m.maxG = Math.max(m.maxG, a / 9.81); m.minG = Math.min(m.minG, a / 9.81);
  }

  motion(now, a, g, rr) {
    if (!this.active) return;
    const z = (p, k) => (p && p[k] != null ? p[k] : NaN);
    this.buf.motion.push(now - this.t0, z(a, 0), z(a, 1), z(a, 2), z(g, 0), z(g, 1), z(g, 2),
      rr ? rr.alpha ?? NaN : NaN, rr ? rr.beta ?? NaN : NaN, rr ? rr.gamma ?? NaN : NaN);
  }

  gps(now, c, age = 0) {
    if (!this.active) return;
    const t = +(now - this.t0).toFixed(3);
    this.buf.gps.push([t, +c.latitude.toFixed(6), +c.longitude.toFixed(6), c.speed == null ? null : +c.speed.toFixed(2),
      Math.round(c.accuracy), c.heading == null ? null : Math.round(c.heading), +age.toFixed(2)]);
    if (this.lastFix && c.accuracy < 40) this.meta.distanceM += haversine(this.lastFix, [c.latitude, c.longitude]);
    if (c.accuracy < 40) this.lastFix = [c.latitude, c.longitude];
    if (c.speed != null && c.accuracy < 40) this.meta.gpsMaxKmh = Math.max(this.meta.gpsMaxKmh, c.speed * 3.6);
    this.meta.gpsN++;
  }

  event(now, e) {
    if (!this.active) return;
    this.buf.events.push([+(now - this.t0).toFixed(3), e.kind, e.from, e.to, e.rpm]);
  }

  // anything else worth knowing when analysing: marks, setting changes, page hidden/visible
  note(now, kind, ...args) {
    if (!this.active) return;
    this.buf.events.push([+(now - this.t0).toFixed(3), kind, ...args]);
    if (kind === 'mark') this.meta.marks++;
    if (kind === 'sim' && args[0]) this.meta.simUsed = true;
  }

  async flush() {
    if (!this.buf || (!this.buf.rows.length && !this.buf.gps.length && !this.buf.events.length)) return;
    const c = { id: this.id, seq: this.seq++, ...this.buf, motion: new Float32Array(this.buf.motion) };
    this.buf = { rows: [], gps: [], events: [], motion: [] };
    try {
      await store.putChunk(c);
      this.meta.updatedMs = Date.now();
      await store.putMeta({ ...this.meta, distanceM: Math.round(this.meta.distanceM) });
    } catch (e) { console.warn('drive save failed', e); }
  }

  async stop() {
    if (!this.active) return;
    this.note(performance.now() / 1000, 'stop');
    this.active = false;
    this.meta.ended = true;
    clearInterval(this.timer);
    await this.flush();
    if (this.meta.rowsN < 50) { await store.remove(this.id); return null; }    // ignore accidental starts
    return this.id;
  }
}

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function summarize(d) {
  const rows = d.rows || [], gps = d.gps || [];
  let maxKmh = 0, maxG = 0, minG = 0, dist = 0, last = null, gpsMaxKmh = 0;
  for (const r of rows) { maxKmh = Math.max(maxKmh, r[1] * 3.6); maxG = Math.max(maxG, r[2] / 9.81); minG = Math.min(minG, r[2] / 9.81); }
  for (const g of gps) {
    if (g[3] != null && g[4] < 40) gpsMaxKmh = Math.max(gpsMaxKmh, g[3] * 3.6);
    if (g[1] == null || g[4] > 40) continue;
    if (last) dist += haversine(last, [g[1], g[2]]);
    last = [g[1], g[2]];
  }
  const startedMs = d.startedMs || Date.parse(d.started) || Date.now();
  const { rows: _r, gps: _g, events: _e, motion: _m, app: _a, ...rest } = d;
  return { ...rest, id: d.id, startedMs, started: new Date(startedMs).toISOString(), columns: d.columns || ROW_COLS,
    gpsColumns: d.gpsColumns || GPS_COLS, rowsN: rows.length, gpsN: gps.length,
    marks: (d.events || []).filter((e) => e[1] === 'mark').length, ended: true,
    durationS: rows.length ? rows[rows.length - 1][0] : 0, distanceM: Math.round(dist), maxKmh, maxG, minG, gpsMaxKmh };
}

// older exports -> current shape (v2 and later carry their own column lists)
export function normalizeImport(j) {
  if (j.app !== 'v8drive') throw new Error('Not a V8 Drive log');
  if (j.version >= 2) return j;
  const rows = (j.rows || []).map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]]);
  const gps = (j.gps || []).map((g) => [g[0], null, null, g[1], g[2], g[3]]);
  return { app: 'v8drive', version: 2, started: j.started, settings: j.settings, rows, gps, events: [] };
}

// The analysis file: everything recorded, plus the app version and the settings in force.
export function driveJson(d, appVersion) {
  return JSON.stringify({ app: 'v8drive', version: LOG_VERSION, appVersion, ...d });
}
export const driveFileName = (d) => `v8drive-${d.started.slice(0, 16).replace(/[-:T]/g, '')}.json`;

export function exportDrive(d, appVersion) {
  const blob = new Blob([driveJson(d, appVersion)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = driveFileName(d);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ------------------------------------------------------------------ view

let leafletReady = null;
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    css.integrity = 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==';
    css.crossOrigin = 'anonymous';
    document.head.appendChild(css);
    const s = document.createElement('script');
    // pinned by hash: this page may hold the upload token, so only this exact file may run
    s.integrity = 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==';
    s.crossOrigin = 'anonymous';
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => res(window.L);
    s.onerror = () => rej(new Error('Map library failed to load'));
    document.head.appendChild(s);
  });
  return leafletReady;
}

const METRICS = {
  speed: { label: 'Speed', unit: 'km/h' },
  accel: { label: 'Acceleration', unit: 'g' },
  rpm: { label: 'RPM', unit: 'rpm' },
  gear: { label: 'Gear', unit: '' },
  load: { label: 'Throttle', unit: '%' },
};
const GEAR_COLORS = ['#888', '#4aa8ff', '#3ecf8e', '#c6e05a', '#ffb020', '#ff7a1f', '#ff3d6e', '#b36bff', '#7f8cff', '#2fd4d4', '#ffffff'];

function lerpColor(stops, x) {
  x = Math.min(1, Math.max(0, x));
  for (let i = 0; i < stops.length - 1; i++) {
    const [x0, c0] = stops[i], [x1, c1] = stops[i + 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0 || 1);
      const p = (h, k) => parseInt(h.slice(1 + 2 * k, 3 + 2 * k), 16);
      const c = [0, 1, 2].map((k) => Math.round(p(c0, k) + (p(c1, k) - p(c0, k)) * t));
      return `rgb(${c.join(',')})`;
    }
  }
  return stops[stops.length - 1][1];
}

export class DrivesView {
  constructor(el, getCfg, appVersion) {
    this.el = el; this.getCfg = getCfg; this.appVersion = appVersion;
    this.metric = 'accel';
    this.drive = null;
    this.map = null;
  }

  async refresh() {
    const list = await store.list().catch(() => []);
    const box = this.el.querySelector('#driveList');
    box.innerHTML = list.length ? '' : '<p class="note">No saved drives yet. Drives record automatically while the engine is running (see the switch above), or import a JSON log.</p>';
    for (const m of list) {
      const b = document.createElement('button');
      b.className = 'driveItem' + (this.drive && this.drive.id === m.id ? ' on' : '');
      const d = new Date(m.startedMs);
      b.innerHTML = `<b>${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</b>
        <span>${fmtDur(m.durationS)} · ${(m.distanceM / 1000).toFixed(1)} km · max ${Math.round(m.maxKmh)} km/h · ${m.maxG.toFixed(2)} g${m.sim ? ' · simulator' : ''}${m.marks ? ` · ${m.marks} marks` : ''}${m.uploaded ? ' · uploaded ✓' : ''}${m.ended === false ? ' · recording' : ''}</span>`;
      b.addEventListener('click', () => this.open(m.id));
      box.appendChild(b);
    }
  }

  async open(id) {
    this.drive = await store.load(id);
    this.shareFile = null;
    this.el.querySelector('#driveUpInfo').textContent = this.drive.uploaded ? `Uploaded as ${this.drive.uploaded}` : '';
    const d = this.drive;
    import('./upload.js?v=7').then((u) => u.gzip(driveJson(d, this.appVersion)))
      .then((gz) => { if (this.drive === d) this.shareFile = new File([gz], driveFileName(d) + '.gz', { type: 'application/gzip' }); })
      .catch(() => {});
    this.el.querySelector('#driveDetail').classList.remove('hidden');
    await this.refresh();
    this.renderStats();
    this.renderChart();
    await this.renderMap();
  }

  async remove() {
    if (!this.drive) return;
    await store.remove(this.drive.id);
    this.drive = null;
    this.el.querySelector('#driveDetail').classList.add('hidden');
    this.refresh();
  }

  // value at a time from the 25 Hz rows (binary search)
  rowAt(t) {
    const r = this.drive.rows;
    let lo = 0, hi = r.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m][0] < t) lo = m; else hi = m; }
    return r[Math.abs(r[lo][0] - t) < Math.abs(r[hi][0] - t) ? lo : hi];
  }

  segValue(t0, t1) {
    const r = this.drive.rows;
    let n = 0, v = 0, a = 0, rpm = 0, load = 0;
    const gears = {};
    for (let i = 0; i < r.length; i++) {
      if (r[i][0] < t0) continue;
      if (r[i][0] > t1) break;
      n++; v += r[i][1]; a += r[i][2]; rpm += r[i][4]; load += r[i][6];
      gears[r[i][5]] = (gears[r[i][5]] || 0) + 1;
    }
    if (!n) { const x = this.rowAt((t0 + t1) / 2); return { v: x[1], a: x[2], rpm: x[4], gear: x[5], load: x[6] }; }
    const gear = +Object.entries(gears).sort((p, q) => q[1] - p[1])[0][0];
    return { v: v / n, a: a / n, rpm: rpm / n, gear, load: load / n };
  }

  colorFor(val) {
    const c = this.getCfg();
    switch (this.metric) {
      case 'speed': return lerpColor([[0, '#2b6cff'], [0.35, '#3ecf8e'], [0.65, '#ffd23f'], [1, '#ff3d1f']], val.v * 3.6 / Math.max(60, this.drive.maxKmh || 120));
      case 'rpm': return lerpColor([[0, '#3ecf8e'], [0.5, '#ffd23f'], [1, '#ff3d1f']], (val.rpm - 1000) / 4500);
      case 'gear': return GEAR_COLORS[Math.min(10, val.gear)];
      case 'load': return lerpColor([[0, '#5b6575'], [0.4, '#ffb020'], [1, '#ff3d1f']], val.load);
      default: {
        const g = val.a / 9.81;
        if (g < -0.03) return lerpColor([[0, '#5b6575'], [1, '#2b8cff']], -g / 0.35);
        if (g < c.gSlow) return '#5b6575';
        if (g < c.gMed) return '#3ecf8e';
        if (g < c.gFast) return '#ffd23f';
        if (g < c.gMax) return '#ff7a1f';
        return '#ff2d55';
      }
    }
  }

  legend() {
    const c = this.getCfg();
    const L = {
      accel: [['#2b8cff', 'braking / regen'], ['#5b6575', `cruise < ${c.gSlow} g`], ['#3ecf8e', `gentle ${c.gSlow}–${c.gMed} g (2k shifts)`],
        ['#ffd23f', `medium ${c.gMed}–${c.gFast} g (3k)`], ['#ff7a1f', `hard ${c.gFast}–${c.gMax} g (4k)`], ['#ff2d55', `max > ${c.gMax} g (5k)`]],
      speed: [['#2b6cff', 'slow'], ['#3ecf8e', ''], ['#ffd23f', ''], ['#ff3d1f', `${Math.round(Math.max(60, this.drive.maxKmh))} km/h`]],
      rpm: [['#3ecf8e', '1000'], ['#ffd23f', '3250'], ['#ff3d1f', '5500 rpm']],
      gear: GEAR_COLORS.slice(1, 7).map((col, i) => [col, `${i + 1}`]),
      load: [['#5b6575', 'off'], ['#ffb020', 'part'], ['#ff3d1f', 'full']],
    }[this.metric];
    return L.map(([col, txt]) => `<span><i style="background:${col}"></i>${txt}</span>`).join('');
  }

  async renderMap() {
    const box = this.el.querySelector('#driveMap');
    const fixes = this.drive.gps.filter((g) => g[1] != null && g[4] < 60);
    this.el.querySelector('#mapLegend').innerHTML = this.legend();
    if (fixes.length < 2) {
      box.innerHTML = `<div class="mapEmpty">${this.drive.gps.length ? 'This log has no GPS positions (recorded before positions were saved). Charts below still work.' : 'No GPS in this drive (simulator or GPS off). Charts below still work.'}</div>`;
      this.map = null;
      return;
    }
    let L;
    try { L = await loadLeaflet(); } catch (e) { box.innerHTML = `<div class="mapEmpty">${e.message}</div>`; return; }
    if (this.map) { this.map.remove(); this.map = null; }
    box.innerHTML = '';
    this.map = L.map(box, { zoomControl: true, attributionControl: true, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'darkTiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    const latlngs = fixes.map((g) => [g[1], g[2]]);
    for (let i = 0; i < fixes.length - 1; i++) {
      const val = this.segValue(fixes[i][0], fixes[i + 1][0]);
      L.polyline([latlngs[i], latlngs[i + 1]], { color: this.colorFor(val), weight: 5, opacity: 0.95 }).addTo(this.map)
        .on('click', () => this.setCursor(fixes[i][0]));
    }
    const ev = this.drive.events || [];
    for (const e of ev) {
      const f = (e[1] === 'kickdown' || e[1] === 'mark') && this.fixAt(e[0]);
      if (!f) continue;
      if (e[1] === 'kickdown') L.circleMarker([f[1], f[2]], { radius: 5, color: '#fff', weight: 2, fillColor: '#ff2d55', fillOpacity: 1 })
        .bindTooltip(`Kickdown ${e[2]}→${e[3]}`).addTo(this.map);
      else L.circleMarker([f[1], f[2]], { radius: 7, color: '#fff', weight: 2, fillColor: e[2] === 'wrong' ? '#b36bff' : '#3ecf8e', fillOpacity: 1 })
        .bindTooltip(`Marked: sounded ${e[2]}`).addTo(this.map).on('click', () => this.setCursor(e[0]));
    }
    L.circleMarker(latlngs[0], { radius: 6, color: '#3ecf8e', fillOpacity: 1 }).bindTooltip('Start').addTo(this.map);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#ff3d1f', fillOpacity: 1 }).bindTooltip('End').addTo(this.map);
    this.cursorMarker = L.circleMarker(latlngs[0], { radius: 8, color: '#fff', weight: 3, fillOpacity: 0 }).addTo(this.map);
    this.map.fitBounds(L.latLngBounds(latlngs), { padding: [20, 20] });
  }

  fixAt(t) {
    const f = this.drive.gps.filter((g) => g[1] != null);
    if (!f.length) return null;
    let best = f[0];
    for (const g of f) if (Math.abs(g[0] - t) < Math.abs(best[0] - t)) best = g;
    return best;
  }

  setCursor(t) {
    this.cursorT = t;
    this.drawChart();
    if (this.map && this.cursorMarker) {
      const f = this.fixAt(t);
      if (f) this.cursorMarker.setLatLng([f[1], f[2]]);
    }
  }

  setMetric(m) {
    this.metric = m;
    this.el.querySelectorAll('.metricBtn').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    if (this.drive) this.renderMap();
  }

  renderStats() {
    const d = this.drive, c = this.getCfg(), r = d.rows;
    const bands = [0, 0, 0, 0, 0];
    let accelTime = 0;
    for (let i = 1; i < r.length; i++) {
      const dt = r[i][0] - r[i - 1][0];
      if (dt <= 0 || dt > 1) continue;
      const g = r[i][2] / 9.81;
      if (g < c.gSlow * 0.5) continue;
      accelTime += dt;
      bands[g < c.gSlow ? 0 : g < c.gMed ? 1 : g < c.gFast ? 2 : g < c.gMax ? 3 : 4] += dt;
    }
    const best = (kmh) => {
      let bestT = null;
      for (let i = 0; i < r.length - 1; i++) {
        if (!(r[i][1] <= 0.6 && r[i + 1][1] > 0.6)) continue;     // the moment the car moves off
        let vmax = 0;
        for (let j = i + 1; j < r.length && r[j][0] - r[i][0] < 30; j++) {
          if (r[j][1] * 3.6 >= kmh) { const t = r[j][0] - r[i][0]; if (bestT == null || t < bestT) bestT = t; break; }
          vmax = Math.max(vmax, r[j][1]);
          if (r[j][1] < vmax - 1.5) break;                      // lifted off: not one continuous run
        }
      }
      return bestT == null ? '–' : bestT.toFixed(1) + ' s';
    };
    const kick = (d.events || []).filter((e) => e[1] === 'kickdown').length;
    const shifts = (d.events || []).filter((e) => e[1] === 'up').length;
    const names = ['easy', 'gentle', 'medium', 'hard', 'max'];
    const cols = ['#5b6575', '#3ecf8e', '#ffd23f', '#ff7a1f', '#ff2d55'];
    const tot = accelTime || 1;
    this.el.querySelector('#driveStats').innerHTML = `
      <div class="tiles">
        <div><b>${fmtDur(d.durationS)}</b><span>Duration</span></div>
        <div><b>${(d.distanceM / 1000).toFixed(1)} km</b><span>Distance</span></div>
        <div><b>${Math.round(d.maxKmh)}</b><span>Max km/h</span></div>
        <div><b>${d.maxG.toFixed(2)} g</b><span>Peak accel</span></div>
        <div><b>${(-d.minG).toFixed(2)} g</b><span>Peak decel</span></div>
        <div><b>${best(50)}</b><span>Best 0–50</span></div>
        <div><b>${best(100)}</b><span>Best 0–100</span></div>
        <div><b>${shifts} / ${kick}</b><span>Upshifts / kickdowns</span></div>
      </div>
      <div class="bandTitle">Time spent accelerating, by your shift bands</div>
      <div class="bands">${bands.map((b, i) => `<i style="flex:${b / tot};background:${cols[i]}"></i>`).join('')}</div>
      <div class="bandLbl">${bands.map((b, i) => `<span><i style="background:${cols[i]}"></i>${names[i]} ${Math.round(b / tot * 100)}%</span>`).join('')}</div>`;
  }

  renderChart() {
    const cv = this.el.querySelector('#driveChart');
    const move = (e) => {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const T = this.drive.rows.length ? this.drive.rows[this.drive.rows.length - 1][0] : 0;
      this.setCursor(Math.max(0, Math.min(1, (x * cv.width - 50) / (cv.width - 60))) * T);
    };
    if (!cv._bound) {
      cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); move(e); });
      cv.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') move(e); });
      cv._bound = true;
    }
    this.cursorT = null;
    this.drawChart();
  }

  drawChart() {
    const cv = this.el.querySelector('#driveChart'), g = cv.getContext('2d');
    const d = this.drive, r = d.rows, c = this.getCfg();
    const W = cv.width = cv.clientWidth * 2, H = cv.height = cv.clientHeight * 2;
    g.clearRect(0, 0, W, H);
    if (!r.length) return;
    const T = r[r.length - 1][0] || 1, X0 = 50, X1 = W - 10;
    const xs = (t) => X0 + (X1 - X0) * t / T;
    const panes = [
      { k: 1, f: (v) => v * 3.6, lo: 0, hi: Math.max(60, Math.ceil(d.maxKmh / 20) * 20), col: '#4aa8ff', name: 'km/h' },
      { k: 2, f: (v) => v / 9.81, lo: -0.4, hi: Math.max(0.5, c.gMax + 0.05), col: '#ffb020', name: 'g', lines: [c.gSlow, c.gMed, c.gFast, c.gMax] },
      { k: 4, f: (v) => v, lo: 0, hi: 6000, col: '#ff5a1f', name: 'rpm' },
    ];
    const ph = H / panes.length;
    g.font = '20px -apple-system, system-ui, sans-serif';
    panes.forEach((p, i) => {
      const y0 = i * ph + 8, y1 = (i + 1) * ph - 8;
      const ys = (v) => y1 - (y1 - y0) * (p.f(v) - p.lo) / (p.hi - p.lo);
      const yv = (val) => y1 - (y1 - y0) * (val - p.lo) / (p.hi - p.lo);
      g.strokeStyle = '#2a2e35'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X0, yv(0)); g.lineTo(X1, yv(0)); g.stroke();
      if (p.lines) {
        g.setLineDash([6, 6]);
        for (const L of p.lines) { g.strokeStyle = '#3a3f47'; g.beginPath(); g.moveTo(X0, yv(L)); g.lineTo(X1, yv(L)); g.stroke(); }
        g.setLineDash([]);
      }
      g.fillStyle = '#8b929c'; g.fillText(p.name, 4, y0 + 18); g.fillText(String(p.hi), 4, y0 + 40);
      g.strokeStyle = p.col; g.lineWidth = 2.5; g.beginPath();
      const step = Math.max(1, Math.floor(r.length / (X1 - X0)));
      for (let j = 0; j < r.length; j += step) {
        const x = xs(r[j][0]), y = ys(r[j][p.k]);
        j ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    });
    if (this.cursorT != null) {
      const x = xs(this.cursorT), row = this.rowAt(this.cursorT);
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
      this.el.querySelector('#cursorInfo').textContent =
        `${fmtDur(row[0])} · ${Math.round(row[1] * 3.6)} km/h · ${(row[2] / 9.81).toFixed(2)} g · ${row[4]} rpm · gear ${row[5]} · throttle ${Math.round(row[6] * 100)}%`;
    } else {
      this.el.querySelector('#cursorInfo').textContent = 'Tap the chart or the route to inspect a moment.';
    }
  }
}

function fmtDur(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}
