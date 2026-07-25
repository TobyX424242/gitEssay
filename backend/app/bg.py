"""gitEssay backend — background-thread registry.

Literature parsing (literature_ingest) and summarizing (literature_summary)
run on daemon threads. Tests join these between cases so a previous test's
in-flight work can't leak into the next test's monkeypatch window (the shared
test DB makes cross-test pollution otherwise possible).
"""
import threading
import time

_lock = threading.Lock()
_threads: set[threading.Thread] = set()


def spawn(target, *args) -> threading.Thread:
    """Start a daemon thread running target(*args), tracked for joining."""

    def run() -> None:
        try:
            target(*args)
        finally:
            with _lock:
                _threads.discard(threading.current_thread())

    t = threading.Thread(target=run, daemon=True)
    with _lock:
        _threads.add(t)
    t.start()
    return t


def wait_for_background(timeout: float = 30.0) -> None:
    """Block until no tracked threads remain (or `timeout` seconds elapse)."""
    deadline = time.monotonic() + timeout
    while True:
        with _lock:
            threads = list(_threads)
        if not threads:
            return
        for t in threads:
            t.join(max(0.0, min(0.5, deadline - time.monotonic())))
        if time.monotonic() >= deadline:
            return
