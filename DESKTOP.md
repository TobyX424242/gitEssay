# gitEssay desktop port

Porting gitEssay from a two-container Docker web app to a standalone local
application (Windows / Linux / macOS) with all data stored locally.

## Verdict

**Feasible — the architecture is a natural fit.** The project is local-first
by design: single user, no auth, SQLite storage, no external services
(PostgreSQL/Redis), no WebSocket (streaming uses SSE), and the frontend talks
to the backend over same-origin relative `/api` paths. The only outbound
network dependencies are the user-configured LLM/embedding APIs (unchanged
semantics on desktop) and docling's one-time layout-model download.

A working PoC is complete (see "What's implemented") and verified on Linux:

- ✅ Single-process startup: embedded uvicorn on a free localhost port +
  same-origin serving of the frontend build + a native webview window (falls
  back to the system browser when no GUI toolkit is available)
- ✅ All data lands in the per-user data dir (SQLite, literature files, HF
  model cache)
- ✅ Interrupted literature parses/summaries auto-resume on restart (the
  originals are on disk, so they're re-queued at startup; repeated crashes
  give up and the UI offers a ↻ Retry reparse)
- ✅ The full backend test suite passes; docker/dev flows are unaffected
- ✅ **Frozen-binary smoke test**: `dist/gitessay/gitessay` (1.4 GB onedir)
  starts cleanly, serves frontend + API, and parses an uploaded test PDF
  end-to-end (docling downloads 506 MB of models to the data dir on first
  use → `ready`, with correct page/chunk/title extraction)

## Options considered

| Option | Package size | Effort | UX | Verdict |
|---|---|---|---|---|
| **A. PyInstaller + pywebview (chosen)** | ~1.4 GB onedir, ~0.5 GB compressed | Minimal (done) | System webview window | 99% code reuse, PoC verified |
| B. Tauri + Python sidecar | ~10 MB shell + the same Python sidecar | Large (Rust toolchain, sidecar lifecycle) | Best (native installers, auto-update) | Same Python packaging problem, much more complexity — a possible phase-2 upgrade |
| C. Electron + Python sidecar | ~200 MB shell + the same Python sidecar | Large | Good | Same as B, but heavier |
| D. One-click Docker launcher | ~3.8 GB image | Small | Poor (requires Docker Desktop) | Not a real standalone app — rejected |

**Option A** wins because the FastAPI + SQLite + SSE + background-thread
architecture embeds into any shell unchanged; packaging the Python backend is
the one unavoidable problem shared by A/B/C, and A adds the least new
technology on top. If auto-update or native installers (msi/dmg) become
requirements later, B is a smooth upgrade path that reuses the PyInstaller
sidecar as-is.

## What's implemented

| File | Role |
|---|---|
| `backend/app/desktop.py` | Desktop entry point: resolve the per-user data dir → set env vars → spawn uvicorn on a daemon thread (the `app.main` import happens INSIDE the thread so it never delays the window; free port, asyncio/h11 to avoid frozen-build hidden imports) → open the webview IMMEDIATELY on an inline loading page, then jump to the app once the port answers (browser fallback waits first). The loading page escalates its own message on JS timers (8 s/30 s) so a cold first launch explains itself instead of looking hung; the bootloader splash gets live status text (`pyi_splash.update_text`) at each pre-window milestone. `--server-only` runs headless (tests/CI smoke); `--port N` pins the port. `GITESSAY_BOOT_TIMING=1` appends startup milestones to `<data dir>/boot_timing.log` |
| `backend/app/main.py` | ① Serves the frontend same-origin when `GITESSAY_FRONTEND_BUILD` is set (mounted after the `/api` routers; the docker path is unaffected); ② auto-resumes interrupted literature parses/summaries at startup (with a crash-loop guard; deferred ~5s via a daemon timer so the docling/torch import spike doesn't fight the first page load) and sweeps orphan literature dirs; ③ warms the LangGraph agent stack on a daemon timer (~3 s) — `app/routers/ai.py` imports it lazily (see below) and this keeps the first `/agent/run` cheap |
| `backend/desktop_main.py` + `backend/desktop.spec` | PyInstaller entry and packaging config (onedir, `collect_all(docling…, rapidocr)`, `strip=True`, torch test/bin payload dropped, no UPX to reduce antivirus false positives). Windows builds add a **bootloader splash** (`backend/assets/splash.png`, closed via `pyi_splash` once the webview window is shown) so there's visual feedback from the moment the exe starts — before the Python interpreter even runs — plus the exe icon (`assets/icon.ico`); Linux adds Qt backend hiddenimports (pywebview imports them lazily); macOS wraps the onedir output in a `gitEssay.app` BUNDLE (`assets/icon.icns`) |
| `backend/pyproject.toml` | `desktop` dependency group (platformdirs / pywebview / pyinstaller; Linux-only: PyQt6 + PyQt6-WebEngine + QtPy — the AppImage's bundled webview backend) — `uv sync --group desktop` |
| `scripts/build_desktop.py` | The single build entry point for local AND CI: frontend build → deps → PyInstaller → smoke test → Linux webview check (`--check-webview` offscreen) → per-OS package (**AppImage** / **Inno Setup installer** / **DMG**) + SHA256 |
| `scripts/make_icons.py` + `design/logo.png` → `backend/assets/` | Icon pipeline: crops the quill glyph out of the archived source logo (`design/logo.png`, kept ONLY as the regeneration source — builds consume the committed `backend/assets/icon.*` artifacts), white→transparent via luminance-alpha **un-blend** (no white halo on dark backgrounds), square pad → `icon.png`/`icon-256.png` (Linux), `icon.ico` (Windows), `icon.icns` (macOS). Re-run only when the logo changes |
| `backend/packaging/` | Packaging assets: `gitessay.iss` (Inno Setup — per-user install, wizard, Start Menu/desktop shortcuts, stable AppId for upgrades), `AppRun` + `gitessay.desktop` (AppImage entry; sets `QTWEBENGINE_DISABLE_SANDBOX`) |
| `.github/workflows/desktop.yml` | Three-platform CI matrix (PyInstaller can't cross-compile, so each OS builds its own bundle) that calls the same script; publishes a GitHub Release on `v*` tags, validation-builds on pushes to `main`, and runs manually via `workflow_dispatch` |
| `.github/workflows/ci.yml` | Lightweight per-push/PR CI: backend pytest + frontend build (packaging stays in desktop.yml) |

## Data locations

The platform-standard per-user data dir is resolved at startup (via
`platformdirs`); override with `GITESSAY_DB` / `GITESSAY_DATA_DIR` / `HF_HOME`:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\gitEssay` (e.g. `C:\Users\x\AppData\Roaming\gitEssay`) |
| macOS | `~/Library/Application Support/gitEssay` |
| Linux | `~/.local/share/gitEssay` |

Contents: `gitessay.db` (SQLite — all projects/checkpoints/conversations/AI
settings), `literature/` (uploaded PDF/DOCX originals and extracted figures),
`huggingface/` (docling layout models, ~500 MB downloaded on first PDF parse).
Backup = copy the whole directory.

## Startup performance

What happens between double-click and a usable window, and what's done about
each stage:

| Stage | Typical cost (Windows) | Mitigation |
|---|---|---|
| PyInstaller bootloader + Defender real-time scan of the unsigned ~1 GB bundle | 0.5–2 s warm; tens of seconds on a cold first launch | Bootloader **splash** (`assets/splash.png`) shows from the first moment, with a live status line (`pyi_splash.update_text` at each milestone: environment → server → window toolkit → opening window); **code-sign the exe** (Authenticode) or add the install dir to Defender's exclusion list to cut the real scan time |
| Python interpreter init + `app.desktop` imports | ~0.3 s | Kept stdlib-only at module level |
| `import app.main` (FastAPI/SQLAlchemy) | ~0.9 s warm (was 4.7 s) | Runs **inside the server thread** — never delays the window. The LangGraph agent stack (langchain → langgraph → transformers → **torch**) is NO LONGER on this path — it was ~80% of the import (3.9 s of 4.7 s warm, 76 s of 87 s measured on a cold disk): `app/routers/ai.py` imports it lazily on first `/agent/run`, and a daemon timer warms it 3 s after startup so the first chat doesn't pay it either |
| `import webview` + WebView2 runtime bootstrap | 1–2 s (hard floor for any WebView2 app) | Covered by the splash; window opens on a self-updating loading page (escalates at 8 s/30 s to explain first-launch slowness) and jumps to the app when the port answers |
| Resumed PDF parses (docling/torch import spike) | 10–30 s background CPU | Deferred 5 s past startup so it can't fight the first page load |

To profile a real machine: set `GITESSAY_BOOT_TIMING=1` and read
`<data dir>/boot_timing.log` after launch. `t=0` is when the interpreter
reaches `app.desktop`; whatever a stopwatch shows before that is
bootloader+antivirus time.

## Running and building locally

```bash
# Run from source in desktop mode (requires a built frontend)
cd backend && uv sync --group desktop
uv run python -m app.desktop                  # native webview window
uv run python -m app.desktop --server-only    # server only (headless)

# Package (builds for the current OS) — local and CI share ONE script
python3 scripts/build_desktop.py                  # full pipeline: frontend → deps → PyInstaller → smoke → webview check → package
python3 scripts/build_desktop.py --skip-frontend  # reuse the existing frontend/build
py -3 scripts\build_desktop.py                    # the Windows equivalent (needs Inno Setup 6)
# Output (backend/dist/):
#   linux   gitessay-<version>-linux-x64.AppImage     — self-contained window
#           (bundled Qt WebEngine; NO system WebKitGTK/browser needed)
#   windows gitessay-<version>-windows-x64-setup.exe  — Inno Setup installer
#           (per-user, no admin; wizard + Start Menu/desktop shortcuts)
#   macos   gitessay-<version>-macos-arm64.dmg        — gitEssay.app + drag-to-Applications
# Version: --version flag > GITESSAY_VERSION env > git describe > dev
# Icons:    backend/.venv/bin/python scripts/make_icons.py  (regenerates the
#           committed backend/assets/icon.* from design/logo.png — only needed
#           when the logo changes; builds always use the assets as-is)
```

The platform bundles (linux-x64 / windows-x64 / macos-arm64 — Apple Silicon
only, Intel Macs are not a target) are built by
`.github/workflows/desktop.yml` — CI invokes the **same**
`scripts/build_desktop.py` and only adds system dependencies, npm/uv caching,
and artifact upload. Pushing a `v*` tag creates a GitHub Release with all
packages and their checksums; pushes to `main` run the same matrix as a
validation build (artifacts only, no Release).

Linux notes: the AppImage bundles Qt WebEngine (pywebview's Qt backend) so
the window never needs system WebKitGTK or a browser. It also bundles
`libxcb-cursor.so.0` (Qt ≥ 6.5 hard-requires it for the xcb plugin, but
ubuntu-latest build runners don't ship it — the spec resolves it from the
build machine or the vendored fallback in `backend/assets/libs/` and FAILS
the build if neither has it). Qt still expects common desktop shared libs on
the host (libEGL/libGL, libnss3, libxkbcommon, libxcb — present on any
distro that can run Chrome/Firefox). AppImages also need FUSE 2 at runtime
(`--appimage-extract-and-run` works without it). Built on ubuntu-latest
(glibc 2.39), so distros older than ~2024 are unsupported.

## Risks and caveats

0. **Don't miss package data files**: packages on the docling runtime chain
   that ship data files (e.g. rapidocr's `default_models.yaml` and bundled
   .onnx models) must be `collect_all`'d in the spec, or the frozen build
   fails at runtime with `FileNotFoundError`. Watch for the same class of
   issue when adding parsing dependencies. The inverse hazard exists too:
   **over-excluding breaks torch** — `torch.testing` must stay in the PYZ
   (excluding it makes the first `import torch` fail partway, after
   `torch._C._rpc_init()` has already registered its pybind types; the retry
   then dies with `generic_type: cannot initialize type "RpcBackendOptions":
   an object with that name is already defined`). Rule of thumb: after ANY
   spec change, smoke-test an actual PDF parse, not just server startup.
1. **Size**: the torch(CPU) + docling + opencv chain sets the floor at ~1 GB
   (measured after the size trim: **981 MB onedir, ~390 MB as tar.gz**, down
   from 1.4 GB / 514 MB). The trim: `strip=True` in the spec (~150 MB of debug
   symbols), torch's bundled test suites/binaries dropped (~137 MB), RapidOCR
   pinned to its **torch backend** (the default onnxruntime backend was never
   installed, so scanned-PDF OCR would have crashed — and the now-unused .onnx
   models left the bundle, -31 MB), faker/polyfactory/hf_xet/zstandard._cffi
   excluded, and byte-identical shared libraries hardlink-deduped at build
   time. The remaining floor is the inherent cost of local PDF parsing —
   comparable local-AI apps (e.g. Stable Diffusion bundles) are in the same
   range. A future "slim" variant (docling as an optional, on-demand download)
   could bring the core installer to ~150 MB.
2. **Linux system libraries**: solved — the build uses
   `opencv-python-headless` (same API, no Qt/libGL dependency; a uv override
   prunes docling's transitive `opencv-python`), so the frozen app needs no
   system X11/GL libraries beyond glibc.
3. **First-run model download**: the first PDF parse downloads ~500 MB of
   docling layout models (stored in the data dir; offline thereafter). While
   it runs the UI shows a dedicated `loading_models` phase ("loading AI
   models…") instead of a stalled progress bar. If the model cache ever ends
   up half-written (interrupted download, two app instances racing it, a
   cleaner tool deleting snapshot pointers), a parse that hits a missing model
   file now **repairs the HF snapshot pointers and retries once automatically**
   (`literature_ingest._repair_hf_snapshots`) instead of permanently failing
   with `FileNotFoundError: Missing safe tensors file`. An optional
   alternative to downloads is warming the model cache into the package at
   build time (+500 MB, fully offline).
4. **Windows antivirus false positives**: common for PyInstaller binaries;
   UPX is already off. For public releases, sign the binaries (Windows
   Authenticode / macOS Developer ID + notarization); unsigned macOS builds
   require right-click → Open.
5. **AI features still need the network**: LLM/embedding calls go through the
   user-configured API (key stored in the local SQLite). This doesn't
   conflict with the desktop model — writing/editing works fully offline;
   AI rewriting/agent features need connectivity.
6. **Security model unchanged**: the backend binds `127.0.0.1` on a random
   port, serves same-origin, and keeps CORS closed by default — desktop mode
   is exactly as exposed as the docker deployment (i.e. not exposed).
