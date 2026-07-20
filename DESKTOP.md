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
| `backend/app/desktop.py` | Desktop entry point: resolve the per-user data dir → set env vars → start uvicorn (free port, asyncio/h11 to avoid frozen-build hidden imports) → open webview/browser. `--server-only` runs headless (tests/CI smoke); `--port N` pins the port |
| `backend/app/main.py` | ① Serves the frontend same-origin when `GITESSAY_FRONTEND_BUILD` is set (mounted after the `/api` routers; the docker path is unaffected); ② auto-resumes interrupted literature parses/summaries at startup (with a crash-loop guard) and sweeps orphan literature dirs |
| `backend/desktop_main.py` + `backend/desktop.spec` | PyInstaller entry and packaging config (onedir, `collect_all(docling…, rapidocr)`, no UPX to reduce antivirus false positives) |
| `backend/pyproject.toml` | `desktop` dependency group (platformdirs / pywebview / pyinstaller) — `uv sync --group desktop` |
| `scripts/build_desktop.py` | The single build entry point for local AND CI: frontend build → deps → PyInstaller → smoke test → versioned archive + SHA256 |
| `.github/workflows/desktop.yml` | Four-platform CI matrix (PyInstaller can't cross-compile, so each OS builds its own bundle) that calls the same script; publishes a GitHub Release on `v*` tags |

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

## Running and building locally

```bash
# Run from source in desktop mode (requires a built frontend)
cd backend && uv sync --group desktop
uv run python -m app.desktop                  # native webview window
uv run python -m app.desktop --server-only    # server only (headless)

# Package (builds for the current OS) — local and CI share ONE script
python3 scripts/build_desktop.py                  # full pipeline: frontend → deps → PyInstaller → smoke → archive
python3 scripts/build_desktop.py --skip-frontend  # reuse the existing frontend/build
py -3 scripts\build_desktop.py                    # the Windows equivalent
# Output: backend/dist/gitessay-<version>-<os>-<arch>.(tar.gz|zip) + .sha256
# Version: --version flag > GITESSAY_VERSION env > git describe > dev
```

The four platform bundles (linux-x64 / windows-x64 / macos-arm64 / macos-x64)
are built by `.github/workflows/desktop.yml` — CI invokes the **same**
`scripts/build_desktop.py` and only adds system dependencies, npm/uv caching,
and artifact upload. Pushing a `v*` tag creates a GitHub Release with all
four archives and their checksums.

## Risks and caveats

0. **Don't miss package data files**: packages on the docling runtime chain
   that ship data files (e.g. rapidocr's `default_models.yaml` and bundled
   .onnx models) must be `collect_all`'d in the spec, or the frozen build
   fails at runtime with `FileNotFoundError`. Watch for the same class of
   issue when adding parsing dependencies.
1. **Size**: the torch(CPU) + docling + opencv chain sets the floor at ~1 GB
   (measured: 1.4 GB onedir, ~514 MB as tar.gz). That's the inherent cost of
   local PDF parsing — comparable local-AI apps (e.g. Stable Diffusion
   bundles) are in the same range. A future "slim" variant (docling as an
   optional, on-demand download) could bring the core installer to ~150 MB.
2. **Linux system libraries**: opencv needs `libgl1 libglib2.0-0 libxcb1`
   (Debian/Ubuntu names) at runtime. CI installs them for the build; for
   end-user distribution consider an AppImage bundling these, or document the
   requirement.
3. **First-run model download**: the first PDF parse downloads ~500 MB of
   docling layout models (stored in the data dir; offline thereafter). An
   optional alternative is warming the model cache into the package at build
   time (+500 MB, fully offline).
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
