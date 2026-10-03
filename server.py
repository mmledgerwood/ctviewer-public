"""Local server for the Dicom Viewer.

Serves the static NiiVue-based frontend plus a small JSON/API layer that
discovers studies on the (read-only) source drive and converts the selected
study's DICOM series to a cached NIfTI volume on demand, one (or two, for
quick back-and-forth) at a time to stay within local disk space.
"""
import glob
import hashlib
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import convert

# PUBLIC_MODE serves the app for arbitrary site visitors over the internet,
# instead of the researcher's own machine: local-filesystem endpoints
# (/api/browse, /api/root, /api/pick-folder, /api/studies) are disabled
# since they'd otherwise let any visitor read directory listings off the
# server. Visitors' own DICOM files are converted entirely client-side (WASM
# dcm2niix, see web/vendor/dcm2niix/ and wireUploadUI() in web/app.js) — this
# server never receives them, so there's no upload endpoint to guard either.
PUBLIC_MODE = os.environ.get("PUBLIC_MODE") == "1"

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache", "volumes")
MAX_CACHED_VOLUMES = 2

os.makedirs(CACHE_DIR, exist_ok=True)

_lock = threading.Lock()
_jobs = {}  # study_id -> {"status": ..., "progress": int, "error": str|None}


_paths = {}  # study_id -> series directory, refreshed on every scan


def _scan():
    # Never touches _paths in public mode: local-disk scanning is meaningless
    # there, and clearing/rebuilding the dict would race with concurrent
    # visitors' /api/upload-registered session paths.
    if PUBLIC_MODE:
        return []
    studies = convert.find_studies()
    with _lock:
        _paths.clear()
        _paths.update({s["id"]: s["path"] for s in studies})
    return studies


def _parse_thickness(qs):
    raw = qs.get("thickness", [""])[0]
    try:
        v = float(raw)
        return v if v > 0 else None
    except ValueError:
        return None


def _parse_fast(qs):
    return qs.get("fast", [""])[0] == "1"


def _job_key(study_id, thickness, fast):
    return f"{study_id}::{thickness or 'native'}::{'fast' if fast and thickness else 'full'}"


def _cache_path(study_id, thickness=None, fast=False):
    safe = study_id.replace("^", "_").replace(" ", "_")
    suffix = f"_t{thickness}" if thickness else ""
    suffix += "_fast" if (fast and thickness) else ""
    key = hashlib.md5(f"{_paths.get(study_id, '')}{suffix}".encode()).hexdigest()[:8]
    return os.path.join(CACHE_DIR, f"{safe}{suffix}_{key}.nii.gz")


def _evict_if_needed(keep_id, thickness, fast):
    files = sorted(
        glob.glob(os.path.join(CACHE_DIR, "*.nii.gz")),
        key=os.path.getmtime,
    )
    keep_path = _cache_path(keep_id, thickness, fast)
    files = [f for f in files if f != keep_path]
    while len(files) > MAX_CACHED_VOLUMES - 1:
        oldest = files.pop(0)
        try:
            os.remove(oldest)
        except OSError:
            pass


def _pick_folder_native(start_path):
    """Pop the real macOS folder picker (Finder) and return the chosen POSIX path."""
    def as_literal(s):
        return s.replace("\\", "\\\\").replace('"', '\\"')

    default_clause = ""
    if start_path and os.path.isdir(start_path):
        default_clause = f' default location (POSIX file "{as_literal(start_path)}")'

    script = (
        'POSIX path of (choose folder with prompt "Select CT data folder"'
        f"{default_clause})"
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=600,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"error": str(e)}

    if result.returncode != 0:
        if "User canceled" in result.stderr or "(-128)" in result.stderr:
            return {"cancelled": True}
        return {"error": result.stderr.strip() or "Could not open folder picker"}

    return {"path": result.stdout.strip()}


def _run_conversion(study_id, series_dir, thickness, fast):
    job_key = _job_key(study_id, thickness, fast)
    out_path = _cache_path(study_id, thickness, fast)
    tmp_path = out_path.replace(".nii.gz", ".tmp.nii.gz")

    def progress_cb(p):
        with _lock:
            _jobs[job_key] = {"status": "converting", "progress": p, "error": None}

    try:
        _evict_if_needed(study_id, thickness, fast)
        convert.convert_series(
            series_dir, tmp_path, progress_cb=progress_cb,
            slice_thickness_mm=thickness, fast_preview=fast,
        )
        os.replace(tmp_path, out_path)
        with _lock:
            _jobs[job_key] = {"status": "ready", "progress": 100, "error": None}
    except Exception as e:  # noqa: BLE001
        with _lock:
            _jobs[job_key] = {"status": "error", "progress": 0, "error": str(e)}
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep the console quiet

    def _send_json(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path):
        if path == "/" or path == "":
            # index.html's "Open Folder…" local-filesystem flow would look
            # broken to a public visitor (its endpoints 404 in PUBLIC_MODE)
            # — land them on the upload-based page instead.
            path = "/public.html" if PUBLIC_MODE else "/index.html"
        full = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html", ".js": "application/javascript",
            ".css": "text/css", ".json": "application/json",
            ".wasm": "application/wasm",
        }.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/api/studies":
            if PUBLIC_MODE:
                self.send_error(404)
                return
            try:
                self._send_json({"root": convert.get_root(), "studies": _scan()})
            except OSError as e:
                self._send_json({"root": convert.get_root(), "studies": [], "error": str(e)})
            return

        if parsed.path == "/api/browse":
            if PUBLIC_MODE:
                self.send_error(404)
                return
            path = unquote(qs.get("path", [""])[0]) or convert.get_root()
            path = os.path.abspath(os.path.expanduser(path))
            try:
                dirs = sorted(
                    (n for n in os.listdir(path)
                     if not n.startswith(".") and os.path.isdir(os.path.join(path, n))),
                    key=str.lower,
                )
            except OSError as e:
                self._send_json({"error": str(e), "path": path, "parent": os.path.dirname(path)}, code=400)
                return
            self._send_json({
                "path": path,
                "parent": os.path.dirname(path),
                "dirs": dirs,
                "dcmCount": convert._count_dcm(path),
            })
            return

        if parsed.path == "/api/convert/status":
            study_id = unquote(qs.get("id", [""])[0])
            thickness = _parse_thickness(qs)
            fast = _parse_fast(qs)
            with _lock:
                job = _jobs.get(_job_key(study_id, thickness, fast))
            if job is None:
                cached = os.path.exists(_cache_path(study_id, thickness, fast))
                job = {"status": "ready" if cached else "idle", "progress": 100 if cached else 0, "error": None}
            self._send_json(job)
            return

        if parsed.path == "/api/volume":
            study_id = unquote(qs.get("id", [""])[0])
            path = _cache_path(study_id, _parse_thickness(qs), _parse_fast(qs))
            if not os.path.exists(path):
                self.send_error(404, "Volume not cached yet")
                return
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return

        self._serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        # Same-origin check: compares the Origin header's host against this
        # request's own Host header, rather than a hardcoded localhost allow
        # list, so it works unchanged whether this is reached as
        # http://127.0.0.1:8765 (local) or https://<app>.onrender.com
        # (public) — anything claiming a different Origin is rejected either
        # way.
        origin = self.headers.get("Origin")
        if origin:
            try:
                origin_host = urlparse(origin).netloc
            except ValueError:
                origin_host = ""
            if origin_host != self.headers.get("Host", ""):
                self.send_error(403)
                return

        if parsed.path == "/api/pick-folder":
            if PUBLIC_MODE:
                self.send_error(404)
                return
            self._send_json(_pick_folder_native(convert.get_root()))
            return

        if parsed.path == "/api/root":
            if PUBLIC_MODE:
                self.send_error(404)
                return
            path = os.path.abspath(os.path.expanduser(unquote(qs.get("path", [""])[0])))
            if not os.path.isdir(path):
                self._send_json({"error": "Not a folder"}, code=400)
                return
            convert.set_root(path)
            studies = _scan()
            self._send_json({"root": path, "studies": studies})
            return

        if parsed.path == "/api/convert":
            study_id = unquote(qs.get("id", [""])[0])
            thickness = _parse_thickness(qs)
            fast = _parse_fast(qs)
            if study_id not in _paths:
                _scan()
            if study_id not in _paths:
                self._send_json({"error": "unknown study id"}, code=404)
                return

            job_key = _job_key(study_id, thickness, fast)
            if os.path.exists(_cache_path(study_id, thickness, fast)):
                with _lock:
                    _jobs[job_key] = {"status": "ready", "progress": 100, "error": None}
                self._send_json({"status": "ready"})
                return

            with _lock:
                existing = _jobs.get(job_key)
                if existing and existing["status"] == "converting":
                    self._send_json({"status": "converting"})
                    return
                _jobs[job_key] = {"status": "converting", "progress": 0, "error": None}

            series_dir = _paths[study_id]
            t = threading.Thread(target=_run_conversion, args=(study_id, series_dir, thickness, fast), daemon=True)
            t.start()
            self._send_json({"status": "started"})
            return

        self.send_error(404)


def main(port=8765):
    # Render (and most PaaS hosts) assign the port via $PORT and expect the
    # process to bind every interface (0.0.0.0), not just loopback.
    port = int(os.environ.get("PORT", port))
    host = "0.0.0.0" if PUBLIC_MODE else "127.0.0.1"
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Dicom Viewer running at http://{host}:{port} (public_mode={PUBLIC_MODE})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    import sys
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 8765)
