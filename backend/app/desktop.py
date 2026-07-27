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


# --- opt-in boot timing ------------------------------------------------------
# GITESSAY_BOOT_TIMING=1 appends milestones to <data dir>/boot_timing.log (and
# stdout when there is one). t=0 is when the Python interpreter reaches this
# module — the gap BEFORE that (PyInstaller bootloader + antivirus scan of the
# bundle) is only measurable with a stopwatch from double-click; everything
# after is itemized here.
_T0 = time.monotonic()
_TIMING = os.environ.get("GITESSAY_BOOT_TIMING") == "1"
_timing_buf: list[str] = []


def _tmark(label: str) -> None:
    if not _TIMING:
        return
    line = f"{time.monotonic() - _T0:7.3f}s  {label}"
    _log(f"[boot] {line}")
    data_dir = os.environ.get("GITESSAY_DATA_DIR")
    if not data_dir:
        _timing_buf.append(line)  # flushed once the data dir is known
        return
    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(
            os.path.join(data_dir, "boot_timing.log"), "a", encoding="utf-8"
        ) as f:
            for buffered in _timing_buf:
                f.write(buffered + "\n")
            _timing_buf.clear()
            f.write(line + "\n")
    except OSError:
        pass


_splash_mod = None  # pyi_splash module, cached after first import


def _get_splash():
    """Return the live pyi_splash module, or None when this build has no splash
    (or it has been closed). Importing pyi_splash consumes the _PYI_SPLASH_IPC
    env var on first import, so cache the module — later calls must not key off
    the env var. is_alive() gates every use; close() flips it to False."""
    global _splash_mod
    if _splash_mod is not None:
        return _splash_mod if _splash_mod.is_alive() else None
    if "_PYI_SPLASH_IPC" not in os.environ:
        return None  # no splash in this build — nothing to do (and importing
        # pyi_splash without it just logs a harmless-but-noisy warning)
    try:
        import pyi_splash  # type: ignore[import-not-found]

        _splash_mod = pyi_splash
        return pyi_splash if pyi_splash.is_alive() else None
    except Exception:  # noqa: BLE001 — never let splash handling kill startup
        return None


def _close_splash() -> None:
    """Close the PyInstaller bootloader splash (present only in frozen builds
    whose spec has a Splash block). Safe to call from anywhere, any number of
    times, frozen or not."""
    splash = _get_splash()
    if splash is None:
        return
    try:
        splash.close()
        _tmark("bootloader splash closed")
    except Exception:  # noqa: BLE001 — never let splash handling kill startup
        pass


def _splash_text(msg: str) -> None:
    """Update the bootloader splash's status line (spec: Splash text_pos).
    Covers the pre-window phase (interpreter init + webview import + WebView2
    bootstrap), which on a cold first launch is the slow part. The message is
    interpolated raw into a Tcl command — keep it free of (){}[]$" chars."""
    splash = _get_splash()
    if splash is None:
        return
    try:
        splash.update_text(msg)
    except Exception:  # noqa: BLE001 — never let splash handling kill startup
        pass


_tmark("python interpreter up (app.desktop imported)")


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
# The loading page updates ITSELF on plain JS timers (no IPC back into Python):
# a fast warm launch never sees more than the first line, while a cold first
# launch (Defender scan of the bundle + cold disk cache) escalates to an
# explanation instead of looking hung.
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
  p{margin:0;font-size:14px;color:#9a9aa5;transition:opacity .4s}
  #sub{font-size:12px;color:#6d6d78;max-width:420px;text-align:center;
      line-height:1.6;opacity:0}
  #sub.show{opacity:1}
</style></head>
<body><div class="spin"></div><p id="msg">Starting gitEssay&hellip;</p><p id="sub"></p>
<script>
  var msg = document.getElementById('msg'), sub = document.getElementById('sub');
  setTimeout(function () {
    msg.textContent = 'Loading components…';
    sub.textContent = 'The first launch takes longer than usual.';
    sub.className = 'show';
  }, 8000);
  setTimeout(function () {
    msg.textContent = 'Still loading…';
    sub.textContent = 'A first launch (or an antivirus scan) can take a few ' +
      'minutes — later launches start in seconds.';
    sub.className = 'show';
  }, 30000);
</script></body></html>"""

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
    """Start uvicorn on a daemon thread. The `from app.main import app` import
    (~1s — FastAPI/SQLAlchemy; the heavy LangGraph agent stack is lazy, see
    routers/ai.py) still happens inside the thread so it never delays the
    webview window. asyncio/h11/no-websockets are chosen explicitly so the
    frozen build doesn't need uvloop/httptools/websockets — irrelevant
    perf-wise for a single local client."""

    def _run() -> None:
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
        uvicorn.Server(config).run()

    threading.Thread(target=_run, daemon=True).start()


def _open_window(url: str, port: int) -> None:
    """Native webview window; fall back to the system browser (headless Linux,
    missing GTK/Qt). Either way this blocks until shutdown.

    The window opens IMMEDIATELY on an inline loading page — on a cold first
    launch (antivirus scan + cold disk cache) even the slimmed-down server
    import can take many seconds, and showing nothing the whole time reads as
    "the app didn't launch". Once the port answers, the window jumps to the
    real app."""
    try:
        _splash_text("Loading window toolkit")
        import webview

        _tmark("pywebview imported")
        _splash_text("Opening window")
        window = webview.create_window(
            "gitEssay", html=_LOADING_HTML, width=1440, height=900, min_size=(900, 600)
        )

        def _on_shown() -> None:
            # The real window is on screen — the bootloader splash has done
            # its job (it covered bootloader + interpreter + WebView2 boot).
            _close_splash()
            _tmark("webview window shown (loading page)")

        window.events.shown += _on_shown

        def _jump_when_ready() -> None:
            # Generous timeout: a cold first launch under a real-time antivirus
            # scan can stretch the server import well past a minute, and a
            # false "failed to start" here is far worse than a slow one.
            if _wait_until_up(port, timeout=180.0):
                _tmark("server port up")
                window.load_url(url)
                _tmark("app URL loaded")
            else:
                window.load_html(_FAILED_HTML)

        threading.Thread(target=_jump_when_ready, daemon=True).start()
        # Linux: force the Qt backend — the AppImage bundles PyQt6-WebEngine,
        # so the window needs no system WebKitGTK/browser. Windows/macOS use
        # the OS webview (WebView2 / WKWebView) via pywebview's default.
        webview.start(gui="qt" if sys.platform == "linux" else None)
        return
    except Exception as exc:  # noqa: BLE001 — any GUI failure → browser
        _log(f"[gitessay] webview unavailable ({exc}); opening browser instead.")
    _close_splash()
    if not _wait_until_up(port):
        _log("[gitessay] server failed to start")
        sys.exit(1)
    webbrowser.open(url)
    try:
        threading.Event().wait()  # block until Ctrl+C
    except KeyboardInterrupt:
        pass


def _check_webview() -> None:
    """--check-webview: verify the bundled webview backend imports and a Qt
    offscreen application + WebEngine view can be constructed, then exit.
    Used by the build pipeline to validate the Linux AppImage's Qt WebEngine
    payload headlessly (QT_QPA_PLATFORM=offscreen)."""
    import importlib

    qt = importlib.import_module("webview.platforms.qt")
    _log(f"[gitessay] webview qt platform ok: {qt.__file__}")
    from PyQt6.QtWebEngineWidgets import QWebEngineView
    from PyQt6.QtWidgets import QApplication

    app = QApplication([])
    view = QWebEngineView()
    view.resize(200, 100)
    _log("[gitessay] QWebEngineView constructed — webview backend OK")
    del view, app


def main() -> None:
    _fix_windowed_stdio()
    _splash_text("Preparing environment")
    data_dir = _setup_environment()
    _tmark("environment ready (data dir resolved)")
    frontend = _frontend_dir()
    if frontend:
        os.environ.setdefault("GITESSAY_FRONTEND_BUILD", frontend)

    # --port N pins the port (smoke tests/CI); default is a free random one.
    port_arg = _arg_value("--port")
    port = int(port_arg) if port_arg else _free_port()
    _splash_text("Starting server")
    _start_server(port)
    _tmark("uvicorn thread spawned (server imports run in background)")
    url = f"http://127.0.0.1:{port}/"

    _log(f"[gitessay] data:     {data_dir}")
    _log(f"[gitessay] frontend: {frontend or '(API only — no build found)'}")
    _log(f"[gitessay] serving:  {url}")

    if "--check-webview" in sys.argv:
        _close_splash()
        _check_webview()
        return

    if "--server-only" in sys.argv:
        _close_splash()  # headless: no window will ever dismiss it
        if not _wait_until_up(port):
            _log("[gitessay] server failed to start")
            sys.exit(1)
        _tmark("server port up")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        return
    _open_window(url, port)


if __name__ == "__main__":
    main()
