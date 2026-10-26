"""Receives renders from the dev tools in the browser (render-drive.js, replay.js) and saves
them to listen/ (gitignored). Local only: listens on 127.0.0.1:8766.

Usage: python tools/render_sink.py [out_dir]
"""
import http.server, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'listen')


class Handler(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
        n = int(self.headers['Content-Length'])
        with open(os.path.join(OUT, os.path.basename(self.path)), 'wb') as f:
            f.write(self.rfile.read(n))
        self.send_response(200); self.cors(); self.end_headers(); self.wfile.write(b'ok')

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    print(f'saving renders to {OUT}')
    http.server.HTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
