# PyInstaller spec for the gitEssay desktop app (onedir layout).
#
#   uv sync --group desktop
#   uv run pyinstaller desktop.spec --clean --noconfirm
#
# Output: dist/gitessay/  — run dist/gitessay/gitessay (or gitessay.exe).
# See DESKTOP.md for cross-platform notes (PyInstaller cannot cross-compile;
# build on each target OS, e.g. via .github/workflows/desktop.yml).
import os

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
    # ~150 MB of debug symbols on Linux/macOS. Must stay OFF on Windows:
    # CI runners have Git-Bash strip.exe on PATH, and GNU strip mangles PE
    # binaries (it even chokes on arm64 DLLs) — a stripped build failed the
    # smoke test (exe would not start).
    strip=(os.name != "nt"),
    upx=False,  # UPX inflates antivirus false-positive rates; skip it
    name="gitessay",
)
