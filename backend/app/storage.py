"""gitEssay backend — on-disk storage locations (literature originals/images).

DATA_DIR defaults to the directory of the SQLite DB, so docker (`GITESSAY_DB=
/app/data/gitessay.db`) lands files in the named volume and tests get an
isolated temp dir for free. Override with GITESSAY_DATA_DIR.

Layout:
    <DATA_DIR>/literature/{literature_id}/original.{pdf,docx}
    <DATA_DIR>/literature/{literature_id}/images/img_{seq}.png
"""
import os
import shutil

from app.db import DB_PATH

DATA_DIR = os.environ.get(
    "GITESSAY_DATA_DIR",
    os.path.dirname(os.path.abspath(DB_PATH)),
)


def literature_dir(literature_id: str) -> str:
    return os.path.join(DATA_DIR, "literature", literature_id)


def literature_rel_path(literature_id: str, *parts: str) -> str:
    """DB-stable relative path (relative to DATA_DIR) for a literature file."""
    return os.path.join("literature", literature_id, *parts)


def abs_path(rel_path: str) -> str:
    return os.path.join(DATA_DIR, rel_path)


def sweep_orphan_dirs(valid_ids: set[str]) -> list[str]:
    """Remove literature/<id> directories whose id has no DB row. Returns the
    removed ids (for logging). Called once at startup."""
    root = os.path.join(DATA_DIR, "literature")
    removed: list[str] = []
    if not os.path.isdir(root):
        return removed
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if os.path.isdir(path) and name not in valid_ids:
            shutil.rmtree(path, ignore_errors=True)
            removed.append(name)
    return removed
