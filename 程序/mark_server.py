import http.server
import socketserver
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '数据', 'YOUR_PROJECT_审查总控台')
MARKS = os.path.join(ROOT, 'marks.json')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/api/marks':
            body = open(MARKS, 'rb').read() if os.path.exists(MARKS) else b'{}'
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.split('?')[0] == '/api/shutdown':
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":1}')
            import threading
            threading.Thread(target=self.server.shutdown).start()
            return
        if self.path.split('?')[0] == '/api/marks':
            n = int(self.headers.get('Content-Length', 0))
            data = self.rfile.read(n)
            json.loads(data)
            tmp = MARKS + '.tmp'
            open(tmp, 'wb').write(data)
            os.replace(tmp, MARKS)
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":1}')
        else:
            self.send_error(404)

    def log_message(self, *a):
        pass


with socketserver.ThreadingTCPServer(('127.0.0.1', 18765), Handler) as srv:
    srv.allow_reuse_address = True
    print('serving http://127.0.0.1:18765 (marks -> marks.json)', flush=True)
    srv.serve_forever()
