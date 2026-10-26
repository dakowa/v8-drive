"""Keep every earlier release playable at docs/v/<N>/ and list them all at docs/v/.

Each release tag (v1, v2, ...) other than the current one is unpacked from git into
docs/v/<N>/, without its dev tools. Archives never change once made, so existing folders are
left alone. In each archive:
- settings and drives get their own storage (localStorage key, IndexedDB name), because every
  release on the site shares one origin: without this, an old release would run with the
  current release's saved settings instead of its own, and its drives would mix with the
  current ones. The upload token (v8drive.upload) stays shared, so v7+ archives still upload
  their drives, each tagged with its own appVersion.
- a banner at the top links back to the current release and to the list.

docs/v/index.html is rebuilt from CHANGELOG.md each time.

Usage: python3 tools/build_versions.py <current N>   (tools/release.sh runs it)
"""
import html, io, os, re, subprocess, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V = os.path.join(ROOT, 'docs', 'v')

BANNER = ('<a href="../../" style="display:block;padding:10px 16px;margin:0 0 6px;border-radius:12px;background:#3a2a10;'
          'color:#ffcf80;font:600 14px system-ui;text-align:center;text-decoration:none">'
          'You\'re on v{n}, an older release · back to the current version</a>'
          '<a href="../" style="display:block;margin:0 0 12px;color:#ffb020;font:13px system-ui;'
          'text-align:center">All versions</a>')


def git(*a):
    return subprocess.run(['git', *a], cwd=ROOT, capture_output=True, check=True).stdout


def patch(path, old, new):
    if not os.path.exists(path):
        return
    s = open(path, encoding='utf-8').read()
    if old not in s:
        sys.exit(f'{path}: expected {old!r}')
    open(path, 'w', encoding='utf-8').write(s.replace(old, new))


def archive(n):
    dest = os.path.join(V, str(n))
    if os.path.exists(dest):
        return False
    tmp = dest + '.tmp'
    with tarfile.open(fileobj=io.BytesIO(git('archive', f'v{n}', 'docs'))) as t:
        for m in t.getmembers():
            rel = m.name[len('docs/'):]
            if not rel or rel.split('/')[0] in ('dev', 'prev', 'v'):
                continue
            m.name = rel
            t.extract(m, tmp, filter='data')
    patch(os.path.join(tmp, 'app.js'), "'v8drive.settings'", f"'v8drive.settings.v{n}'")
    patch(os.path.join(tmp, 'drives.js'), "DB = 'v8drive'", f"DB = 'v8drive.v{n}'")
    patch(os.path.join(tmp, 'index.html'), '<body>', '<body>' + BANNER.format(n=n))
    os.rename(tmp, dest)
    return True


def changelog():
    """{N: (heading, [bullet text])} from CHANGELOG.md."""
    out, cur = {}, None
    for line in open(os.path.join(ROOT, 'CHANGELOG.md'), encoding='utf-8'):
        m = re.match(r'## v(\d+)\b(.*)', line)
        if m:
            cur = int(m.group(1)); out[cur] = (m.group(2).strip(' ()'), [])
        elif cur is not None and line.startswith('- '):
            out[cur][1].append(line[2:].strip())
        elif cur is not None and line.startswith('  ') and out[cur][1]:
            out[cur][1][-1] += ' ' + line.strip()
    return out


def inline(s):
    s = html.escape(s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', s)


def page(current, notes):
    rows = []
    for n in sorted(notes, reverse=True):
        _, items = notes[n]
        href = '../' if n == current else f'{n}/'
        tag = ' <span class="cur">current</span>' if n == current else ''
        lis = ''.join(f'<li class="{"verdict" if t.startswith("**Verdict") else ""}">{inline(t)}</li>' for t in items)
        rows.append(f'<section><a class="open" href="{href}">v{n}{tag}<span>Open ›</span></a><ul>{lis}</ul></section>')
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0c0e">
<title>V8 Drive versions</title>
<style>
:root {{ --bg: #0b0c0e; --panel: #15171b; --line: #2a2e35; --text: #eef0f3; --dim: #8b929c; --accent: #ff5a1f; --accent2: #ffb020; }}
html, body {{ margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }}
body {{ padding: max(16px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); max-width: 560px; margin: 0 auto; }}
h1 {{ font-size: 22px; margin: 4px 0 4px; }}
p {{ color: var(--dim); font-size: 13.5px; margin: 0 0 14px; }}
section {{ background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-bottom: 12px; }}
a.open {{ display: flex; align-items: center; gap: 8px; color: var(--text); text-decoration: none; font-weight: 700; font-size: 18px; }}
a.open span {{ margin-left: auto; font-size: 14px; color: var(--accent2); font-weight: 600; }}
a.open .cur {{ margin-left: 0; font-size: 11px; color: #1a0700; background: var(--accent); border-radius: 999px; padding: 2px 8px; }}
ul {{ margin: 8px 0 0; padding-left: 18px; color: var(--dim); font-size: 13.5px; }}
li {{ margin: 3px 0; }}
li.verdict {{ color: var(--text); }}
code {{ font-size: 12.5px; }}
</style>
</head>
<body>
<h1>V8 Drive versions</h1>
<p>Every release stays playable. Older releases keep their own settings and drives, so each one sounds exactly as it shipped. There is no v6.</p>
{''.join(rows)}
</body>
</html>
'''


def main():
    current = int(sys.argv[1])
    tags = sorted(int(t[1:]) for t in git('tag', '-l', 'v[0-9]*').decode().split() if t[1:].isdigit())
    os.makedirs(V, exist_ok=True)
    for n in tags:
        if n != current and archive(n):
            print(f'archived v{n} at docs/v/{n}/')
    notes = changelog()
    if current not in notes:
        sys.exit(f"CHANGELOG.md has no '## v{current}' entry")
    notes = {n: v for n, v in notes.items() if n == current or n in tags}
    open(os.path.join(V, 'index.html'), 'w', encoding='utf-8').write(page(current, notes))


if __name__ == '__main__':
    main()
