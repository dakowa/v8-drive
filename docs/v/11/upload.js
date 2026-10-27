// Drive upload for analysis: each finished real drive goes, gzipped, into the user's own
// private GitHub repo (drives/<file>.json.gz), where Claude picks it up (tools/pull_drives.py).
// The token is the user's fine-grained GitHub token (one repo, Contents read/write). It lives
// only in this phone's localStorage under its own key, never in the settings that drives
// record, and is sent only to api.github.com.

import { store, driveJson, driveFileName } from './drives.js?v=11';

const KEY = 'v8drive.upload';
const PART = 20 * 1024 * 1024;     // bigger files go up in parts (.000, .001, ...)
const STALE_MS = 10 * 60 * 1000;   // an unfinished drive not saved for this long is over
const MIN_GPS_KMH = 15;            // real drives only: the simulator never moves the GPS

export function uploadCfg() {
  try { return { on: false, repo: 'dakowa/v8-drive-logs', token: '', ...JSON.parse(localStorage.getItem(KEY)) }; } catch (e) {
    return { on: false, repo: 'dakowa/v8-drive-logs', token: '' };
  }
}
export function saveUploadCfg(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* private mode */ }
}

// drives from before v7 have no GPS max speed: trust the fused speed unless it was the simulator
export const isRealDrive = (m) => m.ended && (m.gpsMaxKmh ?? (m.sim ? 0 : m.maxKmh)) >= MIN_GPS_KMH;

export async function gzip(text) {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function put(c, path, bytes, message) {
  const url = `https://api.github.com/repos/${c.repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const body = { message, content: b64(bytes) };
  const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  // 422: the file exists. Names are unique per drive and a PUT is all-or-nothing, so an earlier
  // attempt landed but its reply was lost (phone locked mid-upload)
  if (r.status === 422) return;
  if (!r.ok) {
    const msg = { 401: 'token rejected', 403: 'token lacks access to this repo', 404: 'repo not found (or token lacks access)' }[r.status];
    throw new Error(`GitHub ${r.status}: ${msg || (await r.text()).slice(0, 120)}`);
  }
}

export async function uploadDrive(id, appVersion, c = uploadCfg()) {
  if (!c.token || !c.repo) throw new Error('Add the GitHub repo and token first');
  const d = await store.load(id);
  const gz = await gzip(driveJson(d, appVersion));
  const name = 'drives/' + driveFileName(d) + '.gz';
  const msg = `Drive ${d.started.slice(0, 16)} · ${Math.round(d.durationS / 60)} min · ${(d.distanceM / 1000).toFixed(1)} km · ${d.marks || 0} marks`;
  if (gz.length <= PART) await put(c, name, gz, msg);
  else for (let i = 0, k = 0; i < gz.length; i += PART, k++) await put(c, `${name}.${String(k).padStart(3, '0')}`, gz.subarray(i, i + PART), `${msg} (part ${k + 1})`);
  const { rows, gps, events, motion, ...meta } = d;
  await store.putMeta({ ...meta, uploaded: name, uploadedMs: Date.now() });
  return { name, bytes: gz.length };
}

// Close drives the app never got to stop (phone locked, Safari closed), then upload every
// finished real drive not yet uploaded. Returns a status line.
let busy = null;
export function syncDrives(appVersion, activeId) {
  if (!busy) busy = doSync(appVersion, activeId).finally(() => { busy = null; });
  return busy;
}
async function doSync(appVersion, activeId) {
  const c = uploadCfg();
  const now = Date.now();
  for (const m of await store.list()) {
    if (!m.ended && m.id !== activeId && now - (m.updatedMs || m.startedMs) > STALE_MS) await store.putMeta({ ...m, ended: true });
  }
  if (!c.on || !c.token) return status(await store.list());
  if (!navigator.onLine) return 'Offline. Will upload later.';
  let err = '';
  for (const m of await store.list()) {
    if (m.uploaded || !isRealDrive(m) || m.noUpload) continue;
    try { await uploadDrive(m.id, appVersion, c); } catch (e) { err = e.message; break; }
  }
  return (err ? `Upload failed: ${err}. ` : '') + status(await store.list());
}
function status(list) {
  const real = list.filter(isRealDrive);
  const up = real.filter((m) => m.uploaded).length;
  return `${up} of ${real.length} real drives uploaded` + (real.length > up ? ` · ${real.length - up} waiting` : '');
}
