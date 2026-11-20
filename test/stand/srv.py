# Локальный сервер для стенда: отдаёт папку как есть и умеет плохие ответы,
# на которых проверяются тайм-ауты и повторы скачивания.
#   python -I test/stand/srv.py <папка> [порт]      (порт по умолчанию 8765)
#   /stall/...   начинает отдавать файл и замолкает на 30 с
#   /slow/...    каждый ответ приходит через ~1.5 с
#   /status/429/..., /status/500/...   ответ с этим кодом
import http.server, sys, os, time
os.chdir(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        # стенд можно подключить к странице сайта (проверка content.js на живом API)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Headers", "*"); self.end_headers()
    def do_GET(self):
        if self.path.startswith("/stall/"):
            self.send_response(200); self.send_header("Content-Length", "100000"); self.end_headers()
            self.wfile.write(b"x" * 1000); self.wfile.flush(); time.sleep(30); return
        if self.path.startswith("/slow/"):
            time.sleep(1.5); self.send_response(200); self.send_header("Content-Length", "5"); self.end_headers()
            self.wfile.write(b"SLOW!"); return
        if self.path.startswith("/status/"):
            code = int(self.path.split("/")[2]); self.send_response(code); self.send_header("Content-Length", "0")
            if code == 429: self.send_header("Retry-After", "1")
            self.end_headers(); return
        return super().do_GET()
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
