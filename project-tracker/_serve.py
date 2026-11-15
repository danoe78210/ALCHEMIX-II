import http.server
import socketserver
import functools
import sys

# Désactive la mise en cache (headers no-cache) pour le live sync.
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

os_dir = functools.partial(NoCacheHandler, directory=r'C:\Dev\alchemixII\project-tracker')

with socketserver.ThreadingTCPServer(('0.0.0.0', 8080), os_dir) as httpd:
    httpd.allow_reuse_address = True
    print('Serving project-tracker on http://0.0.0.0:8080', flush=True)
    httpd.serve_forever()