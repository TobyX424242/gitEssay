"""gitEssay desktop entry point — single-process local app.

Runs the FastAPI backend in-process on a free localhost port, serves the
built frontend from the same origin, and opens it in a native webview window
(falls back to the system browser when no GUI toolkit is available).

All data lives in the per-user data dir (override with the usual env vars):

  Windows : %APPDATA%\\gitEssay
  macOS   : ~/Library/Application Support/gitEssay
  Linux   : ~/.local/share/gitEssay

Run from source:  uv run python -m app.desktop [--server-only]
Packaged build:   see desktop.spec / DESKTOP.md
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser


def _log(msg: str) -> None:
    """print that survives a windowed frozen build (Windows: sys.stdout is None)."""
    try:
        print(msg, flush=True)
    except (AttributeError, OSError):
        pass


def _fix_windowed_stdio() -> None:
    """Windowed frozen builds (desktop.spec: console=False) start with
    sys.stdout/sys.stderr = None on Windows. uvicorn's logging setup then
    crashes on `sys.stdout.isatty()`, and any later print/traceback/handler
    write would crash too. Redirect the missing streams to devnull."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")  # noqa: SIM115
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")  # noqa: SIM115


def _arg_value(flag: str) -> str | None:
    """--flag value from sys.argv, or None when absent."""
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def _setup_environment() -> str:
    """Point DB / uploads / HF model cache at the per-user data dir BEFORE any
    app module is imported (app.db resolves paths at import time). Pre-set env
    vars win, so docker/dev behaviour is unchanged."""
    from platformdirs import user_data_dir

    data_dir = user_data_dir("gitEssay", appauthor=False)
    os.environ.setdefault("GITESSAY_DB", os.path.join(data_dir, "gitessay.db"))
    os.environ.setdefault("GITESSAY_DATA_DIR", data_dir)
    # docling downloads ~500 MB of layout models on first PDF parse; keep them
    # inside the app data dir instead of the global ~/.cache/huggingface.
    os.environ.setdefault("HF_HOME", os.path.join(data_dir, "huggingface"))
    # Honour pre-set overrides too: make sure the resolved dirs actually exist.
    os.makedirs(os.environ["GITESSAY_DATA_DIR"], exist_ok=True)
    os.makedirs(os.path.dirname(os.environ["GITESSAY_DB"]), exist_ok=True)
    os.makedirs(os.environ["HF_HOME"], exist_ok=True)
    return os.environ["GITESSAY_DATA_DIR"]


def _frontend_dir() -> str | None:
    """Locate the built frontend: PyInstaller bundle first, then the repo's
    frontend/build for running from source."""
    candidates = []
    if getattr(sys, "frozen", False):  # PyInstaller bundle
        candidates.append(os.path.join(sys._MEIPASS, "frontend"))  # type: ignore[attr-defined]
    candidates.append(
        os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "build")
    )
    for path in candidates:
        if os.path.isdir(os.path.join(path)):
            return os.path.abspath(path)
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Inline first-paint pages for the desktop window (zero external deps — the
# whole point is that they render instantly while the server is still booting).
_LOADING_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>gitEssay</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
       gap:16px;background:#1e1e24;color:#e8e8ec;
       font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .spin{width:36px;height:36px;border-radius:50%;border:3px solid #444;
        border-top-color:#7aa2ff;animation:r .8s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
  p{margin:0;font-size:14px;color:#9a9aa5}
</style></head>
<body><div class="spin"></div><p>Starting gitEssay&hellip;</p></body></html>"""

_FAILED_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>gitEssay</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#1e1e24;
       color:#e8e8ec;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
</style></head>
<body><p>gitEssay failed to start its local server. Please restart the app.</p></body></html>"""


def _wait_until_up(port: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def _start_server(port: int) -> None:
    """Start uvicorn on a daemon thread. asyncio/h11/no-websockets are chosen
    explicitly so the frozen build doesn't need uvloop/httptools/websockets —
    irrelevant perf-wise for a single local client."""
    from app.main import app  # noqa: PLC0415 — after env setup, paths resolve now

    import uvicorn

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        loop="asyncio",
        http="h11",
        ws="none",
        log_level="warning",
        # Windowed frozen builds have no console to colourize (and a None
        # stdout for uvicorn to probe) — keep the formatter plain.
        use_colors=False,
    )
    threading.Thread(target=uvicorn.Server(config).run, daemon=True).start()


def _open_window(url: str, port: int) -> None:
    """Native webview window; fall back to the system browser (headless Linux,
    missing GTK/Qt). Either way this blocks until shutdown.

    The window opens IMMEDIATELY on an inline loading page — importing the
    server (langchain/numpy/…) can take many seconds on Windows, and showing
    nothing the whole time reads as "the app didn't launch". Once the port
    answers, the window jumps to the real app."""
    try:
        import webview

        window = webview.create_window(
            "gitEssay", html=_LOADING_HTML, width=1440, height=900, min_size=(900, 600)
        )

        def _jump_when_ready() -> None:
            if _wait_until_up(port, timeout=60.0):
                window.load_url(url)
            else:
                window.load_html(_FAILED_HTML)

        threading.Thread(target=_jump_when_ready, daemon=True).start()
        webview.start()
        return
    except Exception as exc:  # noqa: BLE001 — any GUI failure → browser
        _log(f"[gitessay] webview unavailable ({exc}); opening browser instead.")
    if not _wait_until_up(port):
        _log("[gitessay] server failed to start")
        sys.exit(1)
    webbrowser.open(url)
    try:
        threading.Event().wait()  # block until Ctrl+C
    except KeyboardInterrupt:
        pass


def main() -> None:
    _fix_windowed_stdio()
    data_dir = _setup_environment()
    frontend = _frontend_dir()
    if frontend:
        os.environ.setdefault("GITESSAY_FRONTEND_BUILD", frontend)

    # --port N pins the port (smoke tests/CI); default is a free random one.
    port_arg = _arg_value("--port")
    port = int(port_arg) if port_arg else _free_port()
    _start_server(port)
    url = f"http://127.0.0.1:{port}/"

    _log(f"[gitessay] data:     {data_dir}")
    _log(f"[gitessay] frontend: {frontend or '(API only — no build found)'}")
    _log(f"[gitessay] serving:  {url}")

    if "--server-only" in sys.argv:
        if not _wait_until_up(port):
            _log("[gitessay] server failed to start")
            sys.exit(1)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        return
    _open_window(url, port)


if __name__ == "__main__":
    main()
