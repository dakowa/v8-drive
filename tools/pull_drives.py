"""Download drives the phone uploaded to the private logs repo into drives/ (gitignored).

Uses the GitHub CLI's login (gh auth login). Files already downloaded are skipped; files
uploaded in parts (.000, .001, ...) are joined. Prints the new files.

Usage: python tools/pull_drives.py [--repo dakowa/v8-drive-logs]
"""
import argparse, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'drives')


def gh(*args, raw=False):
    r = subprocess.run(['gh', 'api', *(['-H', 'Accept: application/vnd.github.raw'] if raw else []), *args],
                       capture_output=True)
    if r.returncode:
        sys.exit(f'gh api {args[0]} failed: {r.stderr.decode().strip()}')
    return r.stdout if raw else json.loads(r.stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='dakowa/v8-drive-logs')
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    # the replay tool in the browser (docs/dev/replay.js) reads them from docs/dev/drives
    link = os.path.join(ROOT, 'docs', 'dev', 'drives')
    if not os.path.lexists(link):
        os.symlink(os.path.relpath(OUT, os.path.dirname(link)), link)
    # the Trees API lists any number of files (the contents API stops at 1000)
    tree = gh(f'repos/{a.repo}/git/trees/HEAD?recursive=1')['tree']
    files = sorted(t['path'] for t in tree if t['type'] == 'blob' and t['path'].startswith('drives/'))
    groups = {}
    for p in files:
        groups.setdefault(re.sub(r'\.\d{3}$', '', p), []).append(p)
    new = []
    for name, parts in groups.items():
        dest = os.path.join(OUT, os.path.basename(name))
        if os.path.exists(dest):
            continue
        data = b''.join(gh(f'repos/{a.repo}/contents/{p}', raw=True) for p in sorted(parts))
        with open(dest + '.part', 'wb') as f:
            f.write(data)
        os.replace(dest + '.part', dest)
        new.append(dest)
    for p in new:
        print(p)
    print(f'{len(new)} new, {len(groups)} drives in {a.repo}', file=sys.stderr)


if __name__ == '__main__':
    main()
