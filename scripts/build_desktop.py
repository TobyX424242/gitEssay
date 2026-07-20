#!/usr/bin/env python3
"""gitEssay desktop build — single entry point for LOCAL and CI builds.

Runs the whole pipeline: frontend build → backend deps → PyInstaller →
smoke test → versioned archive + SHA256. The CI workflow
(.github/workflows/desktop.yml) calls this exact script, so local and CI
builds can never drift apart.

Usage (from the repo root, any Python 3.10+):
    python3 scripts/build_desktop.py                  # full pipeline
    python3 scripts/build_desktop.py --skip-frontend  # reuse frontend/build
    python3 scripts/build_desktop.py --skip-smoke     # skip the smoke test
    python3 scripts/build_desktop.py --version 1.2.3  # override version

Requires: node/npm (frontend) and uv (backend) on PATH.
Output: backend/dist/gitessay-<version>-<os>-<arch>.(tar.gz|zip) + .sha256
"""
from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(REPO, "frontend")
BACKEND = os.path.join(REPO, "backend")
DIST = os.path.join(BACKEND, "dist")


def log(msg: str) -> None:
    print(msg, flush=True)


def step(msg: str) -> None:
    log(f"\n=== {msg} " + "=" * max(0, 60 - len(msg)))


def die(msg: str, code: int = 1) -> None:
    log(f"ERROR: {msg}")
    sys.exit(code)


def run(cmd: list[str], cwd: str) -> None:
    log(f"$ {' '.join(cmd)}  (cwd: {os.path.relpath(cwd, REPO)})")
    # shell=True on Windows so npm.cmd/uv.exe resolve via PATH.
    r = subprocess.run(cmd, cwd=cwd, shell=(os.name == "nt"))
    if r.returncode != 0:
        die(f"command failed ({r.returncode}): {' '.join(cmd)}")


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def check_prerequisites(skip_frontend: bool) -> None:
    step("prerequisites")
    if not have("uv"):
        die("uv not found — install: https://docs.astral.sh/uv/getting-started/installation/")
    log("uv        ok")
    if skip_frontend:
        return
    missing = [t for t in ("node", "npm") if not have(t)]
    if missing:
        die(f"{', '.join(missing)} not found — install Node.js 22+: https://nodejs.org/")
    log("node/npm  ok")


def resolve_version(cli_version: str | None) -> str:
    if cli_version:
        return cli_version
    env = os.environ.get("GITESSAY_VERSION")
    if env:
        return env
    try:
        out = subprocess.run(
            ["git", "describe", "--tags", "--always", "--dirty"],
            cwd=REPO, capture_output=True, text=True, timeout=10,
        )
        v = out.stdout.strip()
        if out.returncode == 0 and v:
            return v.lstrip("v")
    except Exception:  # noqa: BLE001 — git optional
        pass
    return "dev"


def platform_tag() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    if sys.platform == "darwin":
        return f"macos-{arch}"
    if sys.platform == "win32":
        return f"windows-{arch}"
    return f"linux-{arch}"


def binary_path() -> str:
    exe = "gitessay.exe" if sys.platform == "win32" else "gitessay"
    return os.path.join(DIST, "gitessay", exe)


def smoke_test() -> None:
    step("smoke test")
    binary = binary_path()
    if not os.path.isfile(binary):
        die(f"binary not found: {binary}")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen(
        [binary, "--server-only", "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 90
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                die(f"binary exited early ({proc.returncode}) during smoke test")
            try:
                with urllib.request.urlopen(f"{base}/api/projects", timeout=2) as r:
                    projects = r.read().decode()
                with urllib.request.urlopen(f"{base}/", timeout=2) as r:
                    index = r.read().decode()
                assert '"name"' in projects, "unexpected /api/projects payload"
                assert "<html" in index.lower(), "frontend index.html not served"
                log(f"smoke ok    GET / (html) + GET /api/projects @ {base}")
                return
            except Exception as e:  # noqa: BLE001 — server still starting
                last_err = e
                time.sleep(1)
        die(f"smoke test timed out: {last_err}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def dedupe_hardlinks() -> None:
    """Collapse byte-identical payload files into hardlinks.

    Wheels (numpy / scipy / opencv) each ship their own copies of shared
    libraries (libgfortran, libquadmath, ...). Hardlinking identical copies
    reclaims the duplicate blocks with zero runtime risk — dlopen handles
    hardlinked inodes transparently, tar preserves hardlinks, and zip (which
    can't) simply stores both copies again.
    """
    step("dedupe (hardlinks)")
    bundle = os.path.join(DIST, "gitessay")
    if not os.path.isdir(bundle):
        die(f"bundle not found: {bundle}")
    by_size: dict[int, list[str]] = {}
    for root, _dirs, files in os.walk(bundle):
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p):
                continue
            st = os.stat(p)
            if st.st_size < (1 << 20):  # hashing tiny files costs more than it saves
                continue
            by_size.setdefault(st.st_size, []).append(p)
    saved = 0
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        seen: dict[str, str] = {}
        for p in paths:
            h = hashlib.sha256()
            with open(p, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            original = seen.setdefault(h.hexdigest(), p)
            if original is p:
                continue
            try:
                tmp = p + ".lnk"
                os.link(original, tmp)
                os.replace(tmp, p)
                saved += size
            except OSError:
                pass  # non-CoW/NTFS edge cases — keep both copies
    log(f"dedupe    reclaimed {saved / 1024 / 1024:.0f} MB")


def make_archive(version: str) -> str:
    step("archive")
    bundle = os.path.join(DIST, "gitessay")
    if not os.path.isdir(bundle):
        die(f"bundle not found: {bundle}")
    tag = platform_tag()
    if sys.platform == "win32":
        out = os.path.join(DIST, f"gitessay-{version}-{tag}.zip")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for root, _dirs, files in os.walk(bundle):
                for f in files:
                    p = os.path.join(root, f)
                    z.write(p, os.path.join("gitessay", os.path.relpath(p, bundle)))
    else:
        out = os.path.join(DIST, f"gitessay-{version}-{tag}.tar.gz")
        with tarfile.open(out, "w:gz", compresslevel=6) as t:
            t.add(bundle, arcname="gitessay")
    digest = hashlib.sha256()
    with open(out, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    with open(out + ".sha256", "w") as fh:
        fh.write(f"{digest.hexdigest()}  {os.path.basename(out)}\n")
    size_mb = os.path.getsize(out) / 1024 / 1024
    log(f"archive   {os.path.relpath(out, REPO)}  ({size_mb:.0f} MB)")
    log(f"sha256    {digest.hexdigest()}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="gitEssay desktop build (local + CI)")
    ap.add_argument("--skip-frontend", action="store_true", help="reuse frontend/build as-is")
    ap.add_argument("--skip-smoke", action="store_true", help="skip the post-build smoke test")
    ap.add_argument("--version", default=None, help="override version string (default: git describe)")
    args = ap.parse_args()

    check_prerequisites(args.skip_frontend)
    version = resolve_version(args.version)
    log(f"version   {version}")
    log(f"platform  {platform_tag()}")

    if not args.skip_frontend:
        step("frontend build")
        run(["npm", "ci"], cwd=FRONTEND)
        run(["npm", "run", "build"], cwd=FRONTEND)

    step("backend deps")
    run(["uv", "sync", "--group", "desktop"], cwd=BACKEND)

    step("pyinstaller")
    run(["uv", "run", "pyinstaller", "desktop.spec", "--clean", "--noconfirm"], cwd=BACKEND)

    if not args.skip_smoke:
        smoke_test()

    dedupe_hardlinks()
    out = make_archive(version)
    step("done")
    log(f"built {os.path.relpath(out, REPO)}")


if __name__ == "__main__":
    main()
