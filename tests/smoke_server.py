"""Serve the app for tests/smoke.html and collect its result.

Usage: python3 tests/smoke_server.py <form.odt> <out-dir> [port]
Then open http://localhost:<port>/tests/smoke.html (headless Chrome is fine).
Writes <out-dir>/result.json and the generated files, then exits.
"""
import base64
import json
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
form, out = Path(sys.argv[1]), Path(sys.argv[2])
port = int(sys.argv[3]) if len(sys.argv) > 3 else 8765


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/__form":
            data = form.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.oasis.opendocument.text")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/__result":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        out.mkdir(parents=True, exist_ok=True)
        for name, b64 in body["files"].items():
            (out / name).write_bytes(base64.b64decode(b64))
        (out / "result.json").write_text(json.dumps(body["log"], indent=1, ensure_ascii=False))
        self.send_response(204)
        self.end_headers()
        self.server.done = True

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT)))
server.done = False
server.timeout = 1
while not server.done:
    server.handle_request()
print("\n".join(json.loads((out / "result.json").read_text())))
