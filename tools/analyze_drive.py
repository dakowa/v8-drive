"""Analyse a recorded drive: what the sound did, what the sensors saw, and where they disagree.

Writes drives/reports/<drive>.md (findings with numbers), <drive>.png (overview + every
marked moment) and <drive>.json (the same numbers, for comparing drives).
See ANALYSIS.md for how these feed back into the app's settings and code.

Usage: python tools/analyze_drive.py drives/v8drive-20261027181502.json.gz [more files]
       python tools/analyze_drive.py --new      (every drive in drives/ without a report)
"""
import gzip, json, os, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVES = os.path.join(ROOT, 'drives')
REPORTS = os.path.join(DRIVES, 'reports')
G = 9.81
DEFAULTS = dict(gSlow=0.10, gMed=0.20, gFast=0.32, gMax=0.45, rpmSlow=2000, rpmMed=3000, rpmFast=4000, rpmMax=5000,
                downRpm=2500, gpsLatency=0.45, loadFullG=0.22, pitch=1.0, pitchMode='A', lowSpeed='A',
                sportMinRpm=0, sportBelowKmh=10)
ROW_COLS = ['t', 'v', 'a', 'aRaw', 'rpm', 'gear', 'load', 'aggr']        # before v7 logs listed their own
GPS_COLS = ['t', 'lat', 'lon', 'speed', 'acc', 'heading']
TOP_LOOP_RPM = 4400   # highest recorded engine loop; above it the sound is a sped-up recording


def load(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt') as f:
        d = json.load(f)
    if d.get('app') != 'v8drive':
        raise SystemExit(f'{path}: not a V8 Drive log')
    return d


def table(rows, cols):
    """rows as a dict of numpy columns, by name (files carry their own column lists)."""
    if not rows:
        return {c: np.zeros(0) for c in cols}
    a = np.array([[np.nan if x is None else x for x in r[:len(cols)]] for r in rows], float)
    return {c: a[:, i] for i, c in enumerate(cols[:a.shape[1]])}


def shift_point(c, g):
    pts = [(c['gSlow'], c['rpmSlow']), (c['gMed'], c['rpmMed']), (c['gFast'], c['rpmFast']), (c['gMax'], c['rpmMax'])]
    if g <= pts[0][0]:
        return pts[0][1]
    for (g0, r0), (g1, r1) in zip(pts, pts[1:]):
        if g <= g1:
            return r0 + (r1 - r0) * (g - g0) / (g1 - g0)
    return c['rpmMax']


def q(x, ps=(10, 50, 90)):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    return [round(float(np.percentile(x, p)), 3) for p in ps] if len(x) else None


def episodes(mask, t, min_len=0.0):
    """[(t0, t1)] runs where mask is true."""
    out, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        if (not m or i == len(mask) - 1) and start is not None:
            end = i if not m else i + 1
            if t[end - 1] - t[start] >= min_len:
                out.append((float(t[start]), float(t[end - 1])))
            start = None
    return out


def analyze(d):
    cfg = {**DEFAULTS, **(d.get('settings') or {})}
    R = table(d.get('rows', []), d.get('columns') or ROW_COLS)
    Gp = table(d.get('gps', []), d.get('gpsColumns') or GPS_COLS)
    M = table(d.get('motion', []), d.get('motionColumns') or ['t'])
    ev = d.get('events', [])
    t, v, a = R['t'], R['v'], R['a']
    kmh, gacc = v * 3.6, a / G
    dist_m = d.get('distanceM')
    if not dist_m and len(Gp['t']) > 1 and 'lat' in Gp:
        ok = (Gp['acc'] < 40) & np.isfinite(Gp['lat'])
        la, lo = np.radians(Gp['lat'][ok]), np.radians(Gp['lon'][ok])
        h = np.sin(np.diff(la) / 2) ** 2 + np.cos(la[:-1]) * np.cos(la[1:]) * np.sin(np.diff(lo) / 2) ** 2
        dist_m = float(np.sum(2 * 6371000 * np.arcsin(np.sqrt(h))))
    out = {'id': d.get('id'), 'started': d.get('started'), 'appVersion': d.get('appVersion'), 'sim': d.get('sim'),
           'durationS': round(float(t[-1]), 1) if len(t) else 0, 'distanceKm': round((dist_m or 0) / 1000, 2),
           'settings': {k: cfg.get(k) for k in DEFAULTS}}
    sets = [e for e in ev if e[1] == 'set']
    if sets:
        out['settingsChanged'] = [[round(e[0], 1), e[2], e[3]] for e in sets]

    # ---- data quality
    dt_rows = np.diff(t)
    qual = {'rowHz': round(len(t) / max(t[-1], 1), 1) if len(t) else 0,
            'rowGapsOver1s': int((dt_rows > 1).sum()), 'longestGapS': round(float(dt_rows.max()), 1) if len(dt_rows) else 0,
            'motionHz': round(len(M['t']) / max(t[-1], 1), 1) if len(M['t']) and len(t) else 0,
            'gpsFixes': int(len(Gp['t'])),
            'gpsAccM': q(Gp.get('acc', [])), 'gpsAgeS': q(Gp.get('age', [])) if 'age' in Gp else None,
            'backgrounded': [round(e[0], 1) for e in ev if e[1] == 'hidden']}
    if 'ax' in M and len(M['ax']):
        qual['linearAccelMissingPct'] = round(float(np.isnan(M['ax']).mean() * 100), 1)
    out['dataQuality'] = qual

    # ---- speed: fused vs GPS. GPS speed at fix time tf reflects the true speed at tf - lag;
    # find the lag that best lines GPS up with the fused speed (that is what gpsLatency should be).
    sp = {}
    if len(Gp['t']) > 20 and 'speed' in Gp:
        tf = Gp['t'] - (Gp['age'] if 'age' in Gp else 0)
        ok = np.isfinite(Gp['speed']) & (Gp['acc'] < 40) & (Gp['speed'] > 2)
        if ok.sum() > 20:
            res = []
            for L in np.arange(0, 2.01, 0.05):
                vf = np.interp(tf[ok] - L, t, v)
                res.append((float(np.sqrt(np.mean((Gp['speed'][ok] - vf) ** 2))), round(float(L), 2)))
            best = min(res)
            vf0 = np.interp(tf[ok] - cfg['gpsLatency'], t, v)
            sp = {'bestLagS': best[1], 'rmsAtBestKmh': round(best[0] * 3.6, 2), 'settingGpsLatency': cfg['gpsLatency'],
                  'rmsAtSettingKmh': round(float(np.sqrt(np.mean((Gp['speed'][ok] - vf0) ** 2))) * 3.6, 2),
                  'biasKmh': round(float(np.mean(Gp['speed'][ok] - vf0)) * 3.6, 2),
                  'fixesUsed': int(ok.sum())}
            # speed jumps when a fix corrects the dead-reckoned speed: heard as RPM steps
            jumps = []
            for ta in Gp['t'][ok]:
                i = np.searchsorted(t, ta)
                if 2 <= i < len(t) - 2:
                    jumps.append(abs(v[i + 1] - v[i - 2]) * 3.6)
            sp['correctionJumpKmh'] = q(jumps, (50, 90, 99))
    if 'vTrue' in R:
        sp['synthetic_vRmsKmh'] = round(float(np.sqrt(np.nanmean((R['vTrue'] - v) ** 2))) * 3.6, 2)
    out['speed'] = sp

    # ---- acceleration: how hard the driver actually pulls vs the shift-band thresholds
    acc_on = (gacc > 0.03) & (v > 1)
    pulls = episodes(gacc > cfg['gSlow'] * 0.6, t, 1.5)
    peaks = [float(np.max(gacc[(t >= p0) & (t <= p1)])) for p0, p1 in pulls]
    bands = np.digitize(gacc[acc_on], [cfg['gSlow'], cfg['gMed'], cfg['gFast'], cfg['gMax']])
    dtm = np.median(dt_rows) if len(dt_rows) else 0.04
    out['accel'] = {'accelTimeS': round(float(acc_on.sum() * dtm), 1),
                    'timeShareByBand': dict(zip(['<slow', 'slow-med (2k)', 'med-fast (3k)', 'fast-max (4k)', '>max (5k)'],
                                                [round(float((bands == k).mean()), 3) if len(bands) else 0 for k in range(5)])),
                    'pulls': len(pulls), 'pullPeakG': q(peaks, (10, 25, 50, 75, 90)),
                    'peakG': round(float(gacc.max()), 3) if len(gacc) else 0,
                    'peakDecelG': round(float(-gacc.min()), 3) if len(gacc) else 0,
                    'thresholds': [cfg['gSlow'], cfg['gMed'], cfg['gFast'], cfg['gMax']]}

    # ---- shifts
    ups = [e for e in ev if e[1] == 'up']
    downs = [e for e in ev if e[1] == 'down']
    kicks = [e for e in ev if e[1] == 'kickdown']
    shifts = sorted(ups + downs + kicks, key=lambda e: e[0])
    # direction reversals within 3 s (up then down, or down/kickdown then up): gear hunting
    hunting = [(round(x[0], 1), x[1], round(y[0], 1), y[1]) for x, y in zip(shifts, shifts[1:])
               if y[0] - x[0] < 3 and (x[1] == 'up') != (y[1] == 'up')]
    up_detail = []
    for e in ups:
        i = min(np.searchsorted(t, e[0]), len(t) - 1)
        aggr = R['aggr'][i] if 'aggr' in R else np.nan
        up_detail.append({'t': round(e[0], 1), 'from': e[2], 'rpm': e[4], 'kmh': round(float(kmh[i]), 1),
                          'aggrG': round(float(aggr), 3), 'intendedRpm': round(shift_point(cfg, aggr))})
    out['shifts'] = {'up': len(ups), 'down': len(downs), 'kickdown': len(kicks),
                     'upRpm': q([e[4] for e in ups]), 'downRpm': q([e[4] for e in downs]),
                     'upPerKm': round(len(ups) / max(out['distanceKm'], 0.1), 2),
                     'hunting': hunting[:20], 'huntingCount': len(hunting)}

    # ---- rpm and pitch: time beyond the recorded loops
    rpm = R['rpm']
    snd = rpm * float(cfg.get('pitch') or 1)
    out['rpm'] = {'shareByRange': {f'{lo}-{hi}': round(float(((rpm >= lo) & (rpm < hi)).mean()), 3)
                                   for lo, hi in [(0, 1200), (1200, 2000), (2000, 3000), (3000, 4000), (4000, 5000), (5000, 9000)]},
                  'soundRpmAboveTopLoopS': round(float((snd > TOP_LOOP_RPM).sum() * dtm), 1),
                  'max': int(np.nanmax(rpm)) if len(rpm) else 0}

    # ---- low speed (5-15 km/h): the A/B under test
    low = (kmh > 5) & (kmh < 15)
    eps = episodes(low, t, 1.0)
    out['lowSpeed'] = {'mode': cfg.get('lowSpeed'), 'timeS': round(float(low.sum() * dtm), 1), 'episodes': len(eps),
                       'rpm': q(rpm[low]), 'gears': {int(g): int(n) for g, n in zip(*np.unique(R['gear'][low], return_counts=True))} if low.any() else {}}

    # ---- marks: the moments the driver flagged
    marks = []
    for e in ev:
        if e[1] != 'mark':
            continue
        tm = e[0]
        w = (t >= tm - 6) & (t <= tm + 1)
        near = [[round(x[0] - tm, 1), x[1], *x[2:4]] for x in ev if abs(x[0] - tm) < 6 and x[1] not in ('mark',)]
        fixes = Gp['t'][(Gp['t'] > tm - 2) & (Gp['t'] < tm + 0.5)] if len(Gp['t']) else []
        marks.append({'t': round(tm, 1), 'what': e[2], 'kmh': q(kmh[w], (0, 50, 100)), 'g': q(gacc[w], (0, 50, 100)),
                      'rpm': q(rpm[w], (0, 50, 100)), 'gears': sorted({int(x) for x in R['gear'][w]}),
                      'load': q(R['load'][w], (0, 50, 100)) if 'load' in R else None,
                      'eventsWithin6s': near, 'gpsFixesLast2s': len(fixes)})
    out['marks'] = marks
    return out


def plot(d, out, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    cfg = {**DEFAULTS, **(d.get('settings') or {})}
    R = table(d.get('rows', []), d.get('columns') or ROW_COLS)
    Gp = table(d.get('gps', []), d.get('gpsColumns') or GPS_COLS)
    t = R['t']
    marks = out['marks']
    n = 3 + len(marks)
    fig, ax = plt.subplots(n, 1, figsize=(16, 2.6 * 3 + 2.4 * len(marks)), squeeze=False,
                           gridspec_kw={'height_ratios': [1.2, 1, 1.2] + [1] * len(marks)})
    ax = ax[:, 0]

    def panel(a, sl, title):
        tt = t[sl]
        a.plot(tt, R['v'][sl] * 3.6, color='#1f77b4', lw=1, label='km/h (fused)')
        if len(Gp['t']):
            tf = Gp['t'] - (Gp['age'] if 'age' in Gp else 0)
            m = (tf >= tt[0]) & (tf <= tt[-1]) if len(tt) else tf < 0
            a.plot(tf[m], Gp['speed'][m] * 3.6, '.', color='#17becf', ms=3, label='GPS km/h')
        if 'vTrue' in R:
            a.plot(tt, R['vTrue'][sl] * 3.6, color='k', lw=.6, alpha=.5, label='true (synthetic)')
        b = a.twinx()
        b.plot(tt, R['rpm'][sl], color='#d62728', lw=1, label='rpm')
        b.set_ylim(0, 6500)
        for e in d.get('events', []):
            if len(tt) and tt[0] <= e[0] <= tt[-1]:
                c = {'up': '#2ca02c', 'down': '#9467bd', 'kickdown': '#ff7f0e', 'mark': 'k', 'set': '#8c564b'}.get(e[1])
                if c:
                    a.axvline(e[0], color=c, lw=1.2 if e[1] == 'mark' else .5, ls='-' if e[1] == 'mark' else ':')
        a.set_title(title, fontsize=9, loc='left')
        a.set_ylabel('km/h'); b.set_ylabel('rpm')
        return b

    allr = slice(None)
    panel(ax[0], allr, f"{out['started']}  ·  speed (blue, GPS dots) and rpm (red); lines: up green, down purple, kickdown orange, mark black")
    ax[1].plot(t, R['a'] / G, color='#ff7f0e', lw=.8)
    for th in [cfg['gSlow'], cfg['gMed'], cfg['gFast'], cfg['gMax']]:
        ax[1].axhline(th, color='#999', lw=.6, ls='--')
    ax[1].set_ylabel('g'); ax[1].set_title('acceleration (fused) with shift-band thresholds', fontsize=9, loc='left')
    ax[2].step(t, R['gear'], color='#2ca02c', lw=1, where='post')
    if 'load' in R:
        ax[2].plot(t, R['load'] * 6, color='#bcbd22', lw=.7)
    ax[2].set_ylabel('gear / load×6'); ax[2].set_title('gear (green) and throttle estimate (olive)', fontsize=9, loc='left')
    for k, m in enumerate(marks):
        sl = (t >= m['t'] - 8) & (t <= m['t'] + 3)
        panel(ax[3 + k], sl, f"mark {k + 1}: sounded {m['what']} at {m['t']} s")
    plt.tight_layout()
    plt.savefig(path, dpi=60)
    plt.close(fig)


def report_md(out, name):
    L = [f"# Drive {out['started']}", '',
         f"{out['durationS'] / 60:.1f} min · {out['distanceKm']} km · app v{out['appVersion']} · {len(out['marks'])} marks"
         + (' · **simulator**' if out.get('sim') else ''), '', f'![overview]({name}.png)', '']
    for k, v in out.items():
        if k in ('id', 'started', 'appVersion', 'durationS', 'distanceKm', 'sim'):
            continue
        L += [f'## {k}', '', '```json', json.dumps(v, indent=1), '```', '']
    return '\n'.join(L)


def main():
    args = sys.argv[1:]
    if args == ['--new']:
        names = sorted(f for f in os.listdir(DRIVES) if f.startswith('v8drive-') and f.endswith(('.json', '.json.gz')))
        args = [os.path.join(DRIVES, f) for f in names
                if not os.path.exists(os.path.join(REPORTS, f.replace('.gz', '').replace('.json', '') + '.md'))]
    if not args:
        print('nothing to analyse', file=sys.stderr)
        return
    os.makedirs(REPORTS, exist_ok=True)
    for p in args:
        d = load(p)
        out = analyze(d)
        name = os.path.basename(p).replace('.gz', '').replace('.json', '')
        with open(os.path.join(REPORTS, name + '.json'), 'w') as f:
            json.dump(out, f, indent=1)
        plot(d, out, os.path.join(REPORTS, name + '.png'))
        with open(os.path.join(REPORTS, name + '.md'), 'w') as f:
            f.write(report_md(out, name))
        print(os.path.join(REPORTS, name + '.md'))


if __name__ == '__main__':
    main()
