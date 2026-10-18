#!/usr/bin/env python3
"""Serve app/ for local testing, telling the browser to revalidate every file.

Plain `python3 -m http.server` sends no Cache-Control, so the browser may keep
an old module after a pull or merge and the app dies on a missing export.
Usage: python3 tools/serve.py [port]   (default 8123)
"""
import functools, http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
app = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')
http.server.ThreadingHTTPServer(('', port), functools.partial(NoCache, directory=app)).serve_forever()
