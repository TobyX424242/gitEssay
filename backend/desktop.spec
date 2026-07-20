# PyInstaller spec for the gitEssay desktop app (onedir layout).
#
#   uv sync --group desktop
#   uv run pyinstaller desktop.spec --clean --noconfirm
#
# Output: dist/gitessay/  — run dist/gitessay/gitessay (or gitessay.exe).
# See DESKTOP.md for cross-platform notes (PyInstaller cannot cross-compile;
# build on each target OS, e.g. via .github/workflows/desktop.yml).
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
):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# Trimmed from the frozen app: uvicorn[standard] extras the desktop mode
# never uses (it pins asyncio/h11, ws=none), plus GUI/tooling strays.
# NOTE: `websockets` must stay — langgraph_sdk imports it (stream transport),
# and `dotenv` must stay — the langchain chain imports it lazily at parse time.
EXCLUDES = [
    "pytest",
    "uvloop",
    "httptools",
    "wsproto",
    "watchfiles",
    "tkinter",
]

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
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="gitessay",
    console=False,  # no console window on Windows; harmless on Linux/macOS
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,  # UPX inflates antivirus false-positive rates; skip it
    name="gitessay",
)
