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

Requires: node/npm (frontend) and uv (backend) on PATH. Windows packaging
also needs Inno Setup 6 (preinstalled on windows-latest CI runners).
Output (backend/dist/):
  linux   gitessay-<version>-linux-x64.AppImage        (+ .sha256)
  windows gitessay-<version>-windows-x64-setup.exe     (+ .sha256)
  macos   gitessay-<version>-macos-arm64.dmg           (+ .sha256)
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
import time
import urllib.request

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


def webview_check() -> None:
    """Linux-only: verify the frozen bundle's Qt WebEngine backend imports and
    constructs offscreen — the AppImage's whole point is a window that never
    falls back to the system browser, so gate the build on it."""
    if sys.platform != "linux":
        return
    step("webview backend check")
    env = dict(
        os.environ,
        QT_QPA_PLATFORM="offscreen",
        QTWEBENGINE_DISABLE_SANDBOX="1",
    )
    r = subprocess.run(
        [binary_path(), "--check-webview"],
        env=env,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=180,
    )
    tail = "\n".join((r.stdout or "").splitlines()[-20:])
    if r.returncode != 0 or "webview backend OK" not in (r.stdout or ""):
        die(f"webview check failed ({r.returncode}):\n{tail}")
    log("webview   Qt WebEngine backend ok")


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
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    ok = False
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
                ok = True
                return
            except Exception as e:  # noqa: BLE001 — server still starting
                last_err = e
                time.sleep(1)
        die(f"smoke test timed out: {last_err}")
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
        if not ok:
            # Surface server output on failure — the smoke test is the only
            # CI gate for frozen-build startup bugs, don't fly blind.
            tail = "\n".join((out or "").splitlines()[-40:])
            if tail.strip():
                log(f"--- binary output tail ---\n{tail}")


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


def write_sha256(path: str) -> None:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    with open(path + ".sha256", "w") as fh:
        fh.write(f"{digest.hexdigest()}  {os.path.basename(path)}\n")
    size_mb = os.path.getsize(path) / 1024 / 1024
    log(f"package   {os.path.relpath(path, REPO)}  ({size_mb:.0f} MB)")
    log(f"sha256    {digest.hexdigest()}")


# --- Linux: AppImage ---------------------------------------------------------
APPIMAGETOOL_URL = (
    "https://github.com/AppImage/appimagetool/releases/download/"
    "continuous/appimagetool-x86_64.AppImage"
)


def ensure_appimagetool() -> str:
    """Runnable appimagetool path (downloaded + extracted once; running the
    extracted squashfs-root/AppRun needs no FUSE, unlike the AppImage itself)."""
    tools = os.path.join(DIST, "tools")
    apprun = os.path.join(tools, "squashfs-root", "AppRun")
    if os.path.isfile(apprun):
        return apprun
    os.makedirs(tools, exist_ok=True)
    img = os.path.join(tools, "appimagetool.AppImage")
    log(f"download  {APPIMAGETOOL_URL}")
    urllib.request.urlretrieve(APPIMAGETOOL_URL, img)
    os.chmod(img, 0o755)
    r = subprocess.run([img, "--appimage-extract"], cwd=tools)
    if r.returncode != 0 or not os.path.isfile(apprun):
        die("appimagetool download/extraction failed")
    return apprun


def make_appimage(version: str) -> str:
    """gitessay.AppDir → .AppImage. Layout: the PyInstaller onedir bundle goes
    to usr/share/gitessay/ with a usr/bin/gitessay symlink for the .desktop
    Exec; AppRun sets QTWEBENGINE_DISABLE_SANDBOX (Chromium's setuid sandbox
    helper can't work inside an AppImage mount) and execs the binary."""
    step("appimage")
    bundle = os.path.join(DIST, "gitessay")
    if not os.path.isdir(bundle):
        die(f"bundle not found: {bundle}")
    appdir = os.path.join(DIST, "gitessay.AppDir")
    shutil.rmtree(appdir, ignore_errors=True)
    os.makedirs(os.path.join(appdir, "usr", "bin"))
    shutil.copytree(bundle, os.path.join(appdir, "usr", "share", "gitessay"), symlinks=True)
    os.symlink(
        "../share/gitessay/gitessay", os.path.join(appdir, "usr", "bin", "gitessay")
    )
    pkg = os.path.join(BACKEND, "packaging")
    shutil.copy(os.path.join(pkg, "AppRun"), os.path.join(appdir, "AppRun"))
    os.chmod(os.path.join(appdir, "AppRun"), 0o755)
    shutil.copy(os.path.join(pkg, "gitessay.desktop"), os.path.join(appdir, "gitessay.desktop"))
    shutil.copy(
        os.path.join(BACKEND, "assets", "icon-256.png"),
        os.path.join(appdir, "gitessay.png"),
    )
    tool = ensure_appimagetool()
    out = os.path.join(DIST, f"gitessay-{version}-{platform_tag()}.AppImage")
    machine = platform.machine()
    env = dict(os.environ, ARCH="aarch64" if machine in ("arm64", "aarch64") else "x86_64")
    r = subprocess.run([tool, appdir, out], env=env)
    if r.returncode != 0:
        die(f"appimagetool failed ({r.returncode})")
    os.chmod(out, 0o755)
    write_sha256(out)
    return out


# --- Windows: Inno Setup installer -------------------------------------------
def make_installer(version: str) -> str:
    """Compile backend/packaging/gitessay.iss → <name>-setup.exe (per-user
    install under %LOCALAPPDATA%\\Programs, wizard + Start Menu/desktop
    shortcuts, no admin required)."""
    step("inno setup installer")
    candidates = [
        shutil.which("ISCC.exe"),
        shutil.which("iscc"),
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    ]
    iscc = next((c for c in candidates if c and os.path.isfile(c)), None)
    if not iscc:
        die("Inno Setup 6 not found — install: https://jrsoftware.org/isinfo.php")
    name = f"gitessay-{version}-{platform_tag()}-setup"
    cmd = [
        iscc,
        f"/DAppVersion={version}",
        f"/DSourceDir={os.path.join(DIST, 'gitessay')}",
        f"/DIconFile={os.path.join(BACKEND, 'assets', 'icon.ico')}",
        f"/DOutputDir={DIST}",
        f"/DOutputName={name}",
        os.path.join(BACKEND, "packaging", "gitessay.iss"),
    ]
    # run() uses shell=True on Windows — quote args containing spaces.
    run([f'"{c}"' if " " in c else c for c in cmd], cwd=BACKEND)
    out = os.path.join(DIST, name + ".exe")
    if not os.path.isfile(out):
        die(f"installer not produced: {out}")
    write_sha256(out)
    return out


# --- macOS: DMG ---------------------------------------------------------------
def make_dmg(version: str) -> str:
    """Wrap dist/gitEssay.app (from the spec's BUNDLE step) in a compressed
    DMG with the classic drag-to-Applications symlink."""
    step("dmg")
    app = os.path.join(DIST, "gitEssay.app")
    if not os.path.isdir(app):
        die(f"app bundle not found: {app}")
    staging = os.path.join(DIST, "dmg-staging")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    shutil.copytree(app, os.path.join(staging, "gitEssay.app"), symlinks=True)
    os.symlink("/Applications", os.path.join(staging, "Applications"))
    out = os.path.join(DIST, f"gitessay-{version}-{platform_tag()}.dmg")
    run(
        ["hdiutil", "create", "-volname", "gitEssay", "-srcfolder", staging,
         "-ov", "-format", "UDZO", out],
        cwd=BACKEND,
    )
    if not os.path.isfile(out):
        die(f"dmg not produced: {out}")
    write_sha256(out)
    return out


def package(version: str) -> str:
    if sys.platform == "win32":
        return make_installer(version)
    if sys.platform == "darwin":
        return make_dmg(version)
    return make_appimage(version)


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
        webview_check()

    dedupe_hardlinks()
    out = package(version)
    step("done")
    log(f"built {os.path.relpath(out, REPO)}")


if __name__ == "__main__":
    main()
