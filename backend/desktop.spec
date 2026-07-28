# PyInstaller spec for the gitEssay desktop app (onedir layout).
#
#   uv sync --group desktop
#   uv run pyinstaller desktop.spec --clean --noconfirm
#
# Output: dist/gitessay/  — run dist/gitessay/gitessay (or gitessay.exe).
# See DESKTOP.md for cross-platform notes (PyInstaller cannot cross-compile;
# build on each target OS, e.g. via .github/workflows/desktop.yml).
import os
import sys

from PyInstaller.utils.hooks import collect_all

datas = [("../frontend/build", "frontend")]
binaries = []
hiddenimports = []

# docling ships data files (pipeline/model configs) and lazily imported
# submodules; grab each package wholesale. torch/torchvision/opencv are
# covered by PyInstaller's contrib hooks.
for pkg in (
    "docling",
    "docling_core",
    "docling_parse",
    "docling_ibm_models",
    "rapidocr",  # OCR configs + bundled .onnx models (default_models.yaml)
    "edgeparse",  # tier-1 PDF parser: PyO3 native extension (.so/.pyd)
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# Linux AppImage: the window runs on pywebview's Qt backend (bundled
# PyQt6-WebEngine) instead of system WebKitGTK. pywebview imports its platform
# module and the Qt bindings lazily at runtime, so PyInstaller can't see them
# — list them explicitly. The PyQt6 hooks then pull in the Qt libs,
# QtWebEngineProcess, and webengine resources.
if sys.platform == "linux":
    hiddenimports += [
        "webview.platforms.qt",
        "qtpy",
        "PyQt6.QtCore",
        "PyQt6.QtGui",
        "PyQt6.QtWidgets",
        "PyQt6.QtNetwork",
        "PyQt6.QtWebChannel",
        "PyQt6.QtWebEngineCore",
        "PyQt6.QtWebEngineWidgets",
    ]

# Trimmed from the frozen app: uvicorn[standard] extras the desktop mode
# never uses (it pins asyncio/h11, ws=none), plus tooling strays.
# NOTE: `tkinter` must STAY — the bootloader splash screen (Splash below)
# renders through the bundled Tcl/Tk.
# NOTE: `websockets` must stay — langgraph_sdk imports it (stream transport),
# and `dotenv` must stay — the langchain chain imports it lazily at parse time.
EXCLUDES = [
    "pytest",
    "uvloop",
    "httptools",
    "wsproto",
    "watchfiles",
    # torch's own test suite — never imported at runtime.
    # NOTE: `torch.testing` must NOT be excluded: in the frozen build its
    # absence breaks torch's import chain so the first `import torch` fails
    # partway (after torch._C._rpc_init() already ran); the retry then dies
    # with "generic_type: cannot initialize type RpcBackendOptions: an object
    # with that name is already defined". It costs ~2 MB in the PYZ — keep it.
    "torch.test",
    # Only reachable via docling's ExtractionVlmPipeline (VLM extraction),
    # which this app never uses (DocumentExtractor is not on any code path).
    "faker",
    "polyfactory",
    # Optional HF download accelerator; huggingface_hub falls back to plain
    # HTTP with a warning when it's absent.
    "hf_xet",
    # zstandard loads backend_c (C extension); _cffi is the unused fallback.
    "zstandard._cffi",
    # WeasyPrint (server-side PDF export) needs system Pango/Fontconfig, which
    # can't be relied on outside the Docker image — the export route imports it
    # lazily and answers 501, and the frontend falls back to the browser print
    # flow. Exclude it (and its exclusive deps) from the frozen build instead
    # of shipping ~15 MB that can never work there. Its exclusive deps
    # (fontTools/Brotli/zopfli) are only reachable through it, so modulegraph
    # never pulls them in once it is excluded.
    "weasyprint",
    "pydyf",
    "tinycss2",
    "tinyhtml5",
    "cssselect2",
    "pyphen",
]

# Payload files (not Python modules) dropped after analysis:
#  - torch/bin: upstream test binaries + protoc (~50 MB). torch_shm_manager
#    is kept — torch's dataloader uses it for shared-memory tensors.
#  - torch/test, torch/testing: test suites and data (~88 MB).
#  - rapidocr *.onnx models: the app pins RapidOCR's torch backend (see
#    app/literature_ingest.py), so only the bundled .pth models are used.
DROP_DATA_PREFIXES = ("torch/bin/", "torch/test/", "torch/testing/")


def _drop_payload(name: str) -> bool:
    name = name.replace("\\", "/")
    if name.startswith(DROP_DATA_PREFIXES):
        return not name.endswith("torch/bin/torch_shm_manager")
    if name.startswith("rapidocr/models/") and name.endswith(".onnx"):
        return True
    return False

a = Analysis(
    ["desktop_main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
)
a.datas = [d for d in a.datas if not _drop_payload(d[0])]
a.binaries = [b for b in a.binaries if not _drop_payload(b[0])]

# Qt >= 6.5 links libxcb-cursor.so.0 into the xcb platform plugin — without it
# libqxcb fails to load on end-user machines ("xcb-cursor0 or libxcb-cursor0
# is needed to load the Qt xcb platform plugin"). PyInstaller's dependency
# walker only collects it when the BUILD machine has it installed
# (ubuntu-latest doesn't), so resolve it explicitly: system lib first, then
# the vendored fallback in assets/libs — and fail the build loudly if neither
# exists, instead of shipping an AppImage whose window can't start.
if sys.platform == "linux":
    soname = "libxcb-cursor.so.0"
    if not any(b[0] == soname for b in a.binaries):
        candidates = [
            os.path.join("assets", "libs", soname),
            f"/usr/lib/x86_64-linux-gnu/{soname}",
            f"/usr/lib64/{soname}",
            f"/usr/lib/{soname}",
        ]
        src = next((c for c in candidates if os.path.exists(c)), None)
        if src is None:
            raise SystemExit(
                f"{soname} not found — `apt install libxcb-cursor0` (or drop the "
                "lib into backend/assets/libs/) or the AppImage's window won't start"
            )
        a.binaries.append((soname, os.path.realpath(src), "BINARY"))
pyz = PYZ(a.pure)

# Bootloader-level splash: shown by the PyInstaller bootloader itself, BEFORE
# the Python interpreter starts — this is what the user sees in the first
# seconds after double-clicking (Defender scan + interpreter init + WebView2
# bootstrap all happen underneath it). app.desktop closes it via pyi_splash
# once the real window is on screen, and updates its status line at milestones
# (pyi_splash.update_text — needs text_pos to exist) so a cold first launch
# shows live progress instead of a static image. Tcl/Tk (tkinter) must not be
# excluded for this to work. Windows-only: macOS windowed builds don't support
# it, and on Linux it would break the headless smoke test (Tcl/Tk needs a
# display).
splash_args = []
if sys.platform == "win32":
    splash = Splash(
        "assets/splash.png",
        binaries=a.binaries,
        datas=a.datas,
        # Status line along the bottom of the 480x270 image (dark background,
        # so light gray text). Keep update_text messages short — the line
        # clips at the image edge.
        text_pos=(24, 236),
        text_size=11,
        text_color="#9a9aa5",
        text_default="Starting gitEssay",
        always_on_top=True,
    )
    splash_args = [splash, splash.binaries]

exe = EXE(
    pyz,
    a.scripts,
    *splash_args,
    [],
    exclude_binaries=True,
    name="gitessay",
    console=False,  # no console window on Windows; harmless on Linux/macOS
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Windows: embed the app icon (taskbar/explorer/shortcut). Linux ignores
    # icons on the exe; macOS gets its icon from the BUNDLE below.
    icon="assets/icon.ico" if sys.platform == "win32" else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    # ~150 MB of debug symbols on Linux/macOS. Must stay OFF on Windows:
    # CI runners have Git-Bash strip.exe on PATH, and GNU strip mangles PE
    # binaries (it even chokes on arm64 DLLs) — a stripped build failed the
    # smoke test (exe would not start).
    strip=(os.name != "nt"),
    upx=False,  # UPX inflates antivirus false-positive rates; skip it
    name="gitessay",
)

# macOS: wrap the onedir bundle as gitEssay.app so the DMG ships a real
# double-clickable app with the icon in Finder/Dock. Windows/Linux keep the
# plain onedir output (installer / AppImage handle their presentation).
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="gitEssay.app",
        icon="assets/icon.icns",
        bundle_identifier="com.gitessay.app",
    )
