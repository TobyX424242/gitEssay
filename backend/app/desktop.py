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
    )
    threading.Thread(target=uvicorn.Server(config).run, daemon=True).start()


def _open_window(url: str) -> None:
    """Native webview window; fall back to the system browser (headless Linux,
    missing GTK/Qt). Either way this blocks until shutdown."""
    try:
        import webview

        webview.create_window("gitEssay", url, width=1440, height=900, min_size=(900, 600))
        webview.start()
        return
    except Exception as exc:  # noqa: BLE001 — any GUI failure → browser
        _log(f"[gitessay] webview unavailable ({exc}); opening browser instead.")
    webbrowser.open(url)
    try:
        threading.Event().wait()  # block until Ctrl+C
    except KeyboardInterrupt:
        pass


def main() -> None:
    data_dir = _setup_environment()
    frontend = _frontend_dir()
    if frontend:
        os.environ.setdefault("GITESSAY_FRONTEND_BUILD", frontend)

    # --port N pins the port (smoke tests/CI); default is a free random one.
    port_arg = _arg_value("--port")
    port = int(port_arg) if port_arg else _free_port()
    _start_server(port)
    url = f"http://127.0.0.1:{port}/"
    if not _wait_until_up(port):
        _log("[gitessay] server failed to start")
        sys.exit(1)

    _log(f"[gitessay] data:     {data_dir}")
    _log(f"[gitessay] frontend: {frontend or '(API only — no build found)'}")
    _log(f"[gitessay] serving:  {url}")

    if "--server-only" in sys.argv:
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        return
    _open_window(url)


if __name__ == "__main__":
    main()
