"""gitEssay backend — project archive export/import (.zip).

One archive captures EVERYTHING belonging to a project so it can be restored
as a brand-new project on any gitEssay instance:

    manifest.json                    format marker + project name/timestamps
    checkpoints.json                 full checkpoint DAG (states inlined)
    conversations.json               AI chat history (messages inlined)
    memories.json                    AI long-term notes (literature link by id)
    literature/{lid}/meta.json       literature row (title, summary, parse meta)
    literature/{lid}/chunks.json     parsed chunks incl. embeddings
    literature/{lid}/images.json     figure metadata
    literature/{lid}/original.*      the uploaded PDF/DOCX
    literature/{lid}/images/...      extracted figure PNGs

Import restores at full fidelity (chunks, embeddings and FTS rows are carried
over — no re-parse, no re-embedding, summaries intact). The restored project
always gets fresh ids; its name is de-duplicated OS-style: "Name", "Name (2)",
"Name (3)", ...

AI settings are deliberately NOT exported (per-installation, keychain-backed).
"""
import glob
import io
import json
import logging
import os
import zipfile
from typing import Optional

from sqlalchemy.orm import Session

from app.literature_search import fts_enabled, index_chunk_fts
from app.models import (
    Checkpoint,
    Conversation,
    Literature,
    LiteratureChunk,
    LiteratureImage,
    Memory,
    Project,
    new_id,
    now_ms,
)
from app.storage import abs_path, literature_dir, literature_rel_path

log = logging.getLogger(__name__)

ARCHIVE_FORMAT = "gitessay-project-archive"
ARCHIVE_VERSION = 1
# Import size guard (archives carry raw PDFs, which may each be 50 MB).
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024


class ArchiveError(ValueError):
    """Malformed / unsupported archive — surfaced as HTTP 400."""


# --- export ------------------------------------------------------------------
def build_export_zip(db: Session, project: Project) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        checkpoints = (
            db.query(Checkpoint)
            .filter_by(project_id=project.id)
            .order_by(Checkpoint.created_at)
            .all()
        )
        conversations = (
            db.query(Conversation)
            .filter_by(project_id=project.id)
            .order_by(Conversation.updated_at.desc())
            .all()
        )
        memories = (
            db.query(Memory).filter_by(project_id=project.id).order_by(Memory.created_at).all()
        )
        literatures = (
            db.query(Literature)
            .filter_by(project_id=project.id)
            .order_by(Literature.created_at)
            .all()
        )

        manifest = {
            "format": ARCHIVE_FORMAT,
            "version": ARCHIVE_VERSION,
            "exported_at": now_ms(),
            "project": {
                "name": project.name,
                "created_at": project.created_at,
                "updated_at": project.updated_at,
            },
            # Archive-local id; import remaps it onto the fresh id space.
            "current_checkpoint_id": project.current_checkpoint_id,
        }
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

        zf.writestr(
            "checkpoints.json",
            json.dumps(
                [
                    {
                        "id": c.id,
                        "parent_id": c.parent_id,
                        "state": json.loads(c.state),
                        "source": c.source,
                        "label": c.label,
                        "created_at": c.created_at,
                    }
                    for c in checkpoints
                ],
                ensure_ascii=False,
            ),
        )
        zf.writestr(
            "conversations.json",
            json.dumps(
                [
                    {
                        "title": c.title,
                        "messages": json.loads(c.messages),
                        "created_at": c.created_at,
                        "updated_at": c.updated_at,
                    }
                    for c in conversations
                ],
                ensure_ascii=False,
            ),
        )
        zf.writestr(
            "memories.json",
            json.dumps(
                [
                    {
                        "content": m.content,
                        "literature_id": m.literature_id,
                        "created_at": m.created_at,
                    }
                    for m in memories
                ],
                ensure_ascii=False,
            ),
        )

        for lit in literatures:
            prefix = f"literature/{lit.id}"
            meta = {
                c.name: getattr(lit, c.name)
                for c in Literature.__table__.columns
                if c.name not in ("id", "project_id")
            }
            zf.writestr(
                f"{prefix}/meta.json", json.dumps(meta, ensure_ascii=False, indent=2)
            )
            chunks = (
                db.query(LiteratureChunk)
                .filter_by(literature_id=lit.id)
                .order_by(LiteratureChunk.seq)
                .all()
            )
            zf.writestr(
                f"{prefix}/chunks.json",
                json.dumps(
                    [
                        {
                            "seq": ch.seq,
                            "heading": ch.heading,
                            "text": ch.text,
                            "embedding": json.loads(ch.embedding) if ch.embedding else None,
                        }
                        for ch in chunks
                    ],
                    ensure_ascii=False,
                ),
            )
            images = (
                db.query(LiteratureImage)
                .filter_by(literature_id=lit.id)
                .order_by(LiteratureImage.seq)
                .all()
            )
            zf.writestr(
                f"{prefix}/images.json",
                json.dumps(
                    [
                        {
                            "seq": im.seq,
                            "caption": im.caption,
                            "file": os.path.basename(im.path),
                            "width": im.width,
                            "height": im.height,
                        }
                        for im in images
                    ],
                    ensure_ascii=False,
                ),
            )
            # Raw files (original + figure PNGs) — skipped quietly if missing.
            for path in glob.glob(os.path.join(literature_dir(lit.id), "original.*")):
                zf.write(path, f"{prefix}/{os.path.basename(path)}")
            for im in images:
                path = abs_path(im.path)
                if os.path.isfile(path):
                    zf.write(path, f"{prefix}/images/{os.path.basename(im.path)}")
    return buf.getvalue()


# --- import ------------------------------------------------------------------
def _unique_project_name(db: Session, base: str) -> str:
    """OS-style duplicate naming: "Name", "Name (2)", "Name (3)", ..."""
    base = (base or "").strip() or "Imported project"
    existing = {row[0] for row in db.query(Project.name).all()}
    if base not in existing:
        return base
    n = 2
    while f"{base} ({n})" in existing:
        n += 1
    return f"{base} ({n})"


def _read_json(zf: zipfile.ZipFile, name: str, default):
    try:
        with zf.open(name) as fh:
            return json.loads(fh.read().decode("utf-8"))
    except KeyError:
        return default
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ArchiveError(f"corrupt {name}: {e}") from e


def import_archive(db: Session, data: bytes) -> Project:
    """Restore an exported archive as a NEW project. Raises ArchiveError on
    anything malformed; the DB session is left uncommitted on failure."""
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ArchiveError("archive too large (512 MB max)")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ArchiveError("not a zip archive") from e
    with zf:
        # Zip-slip guard: every entry must stay inside the extraction namespace.
        for info in zf.infolist():
            parts = info.filename.replace("\\", "/").split("/")
            if info.filename.startswith("/") or ".." in parts:
                raise ArchiveError(f"unsafe path in archive: {info.filename!r}")

        manifest = _read_json(zf, "manifest.json", None)
        if not isinstance(manifest, dict) or manifest.get("format") != ARCHIVE_FORMAT:
            raise ArchiveError("not a gitEssay project archive (manifest.json missing)")
        if manifest.get("version") != ARCHIVE_VERSION:
            raise ArchiveError(f"unsupported archive version: {manifest.get('version')!r}")

        pid = new_id()
        now = now_ms()
        project = Project(
            id=pid,
            name=_unique_project_name(db, (manifest.get("project") or {}).get("name", "")),
            created_at=now,
            updated_at=now,
        )
        db.add(project)
        db.flush()  # parent row before FK children

        # Checkpoints (remap ids, preserve the DAG + timestamps).
        id_map: dict[str, str] = {}
        raw_checkpoints = _read_json(zf, "checkpoints.json", [])
        for c in raw_checkpoints:
            id_map[c["id"]] = new_id()
        for c in raw_checkpoints:
            db.add(
                Checkpoint(
                    id=id_map[c["id"]],
                    project_id=pid,
                    parent_id=id_map.get(c.get("parent_id") or ""),
                    state=json.dumps(c.get("state"), ensure_ascii=False),
                    source=c.get("source") or "manual",
                    label=c.get("label"),
                    created_at=c.get("created_at") or now,
                )
            )
        old_current = manifest.get("current_checkpoint_id")
        if old_current and old_current in id_map:
            project.current_checkpoint_id = id_map[old_current]
        elif raw_checkpoints:
            latest = max(raw_checkpoints, key=lambda c: c.get("created_at") or 0)
            project.current_checkpoint_id = id_map[latest["id"]]

        # Conversations (chat history); the most recently updated one becomes
        # the project's active conversation.
        conversations = _read_json(zf, "conversations.json", [])
        active_cid: Optional[str] = None
        if conversations:
            newest = max(conversations, key=lambda c: c.get("updated_at") or 0)
        for c in conversations:
            cid = new_id()
            db.add(
                Conversation(
                    id=cid,
                    project_id=pid,
                    title=c.get("title") or "New conversation",
                    messages=json.dumps(c.get("messages") or [], ensure_ascii=False),
                    created_at=c.get("created_at") or now,
                    updated_at=c.get("updated_at") or now,
                )
            )
            if c is newest:
                active_cid = cid
        project.active_conversation_id = active_cid

        # Literature: rows + chunks (with embeddings) + FTS + on-disk files.
        lit_id_map: dict[str, str] = {}
        lit_dirs = sorted(
            {
                info.filename.split("/")[1]
                for info in zf.infolist()
                if info.filename.startswith("literature/") and len(info.filename.split("/")) > 2
            }
        )
        for old_lid in lit_dirs:
            meta = _read_json(zf, f"literature/{old_lid}/meta.json", None)
            if not isinstance(meta, dict):
                continue  # a stray directory without metadata is not literature
            lid = new_id()
            lit_id_map[old_lid] = lid
            status = meta.get("status") or "ready"
            error = meta.get("error")
            if status == "processing":
                # Exported mid-parse: nothing reliable to restore derived data
                # from — mark for a manual reparse (the original is included).
                status, error = "error", "Imported mid-parse — use ↻ Retry to parse again."
            lit = Literature(
                id=lid,
                project_id=pid,
                filename=meta.get("filename") or "upload",
                title=meta.get("title") or meta.get("filename") or "",
                status=status,
                error=error,
                summary=meta.get("summary"),
                summary_status=meta.get("summary_status") or "none",
                embed_status=meta.get("embed_status") or "none",
                parse_attempts=0,
                parse_engine=meta.get("parse_engine"),
                parse_confidence=meta.get("parse_confidence") or "none",
                parse_eval_note=meta.get("parse_eval_note"),
                page_count=meta.get("page_count") or 0,
                char_count=meta.get("char_count") or 0,
                chunk_count=meta.get("chunk_count") or 0,
                image_count=meta.get("image_count") or 0,
                created_at=meta.get("created_at") or now,
            )
            db.add(lit)

            target_dir = literature_dir(lid)
            os.makedirs(target_dir, exist_ok=True)
            prefix = f"literature/{old_lid}/"
            for info in zf.infolist():
                if not info.filename.startswith(prefix) or info.is_dir():
                    continue
                rel = info.filename[len(prefix):]
                if rel.endswith(".json"):
                    continue  # metadata, handled explicitly
                dest = os.path.join(target_dir, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as dst:
                    dst.write(src.read())

            for ch in _read_json(zf, f"literature/{old_lid}/chunks.json", []):
                chunk_id = new_id()
                db.add(
                    LiteratureChunk(
                        id=chunk_id,
                        literature_id=lid,
                        seq=ch.get("seq") or 0,
                        heading=ch.get("heading") or "",
                        text=ch.get("text") or "",
                        embedding=(
                            json.dumps(ch["embedding"]) if ch.get("embedding") else None
                        ),
                    )
                )
                if fts_enabled():
                    index_chunk_fts(
                        db, lid, chunk_id, ch.get("heading") or "", ch.get("text") or ""
                    )
            for im in _read_json(zf, f"literature/{old_lid}/images.json", []):
                db.add(
                    LiteratureImage(
                        id=new_id(),
                        literature_id=lid,
                        seq=im.get("seq") or 0,
                        caption=im.get("caption") or "",
                        path=literature_rel_path(lid, "images", im.get("file") or ""),
                        width=im.get("width") or 0,
                        height=im.get("height") or 0,
                    )
                )

        # Memories last (they reference the remapped literature ids).
        for m in _read_json(zf, "memories.json", []):
            db.add(
                Memory(
                    id=new_id(),
                    project_id=pid,
                    literature_id=lit_id_map.get(m.get("literature_id") or ""),
                    content=m.get("content") or "",
                    created_at=m.get("created_at") or now,
                )
            )

        db.commit()
        db.refresh(project)
        log.info("imported project archive as %r (%s)", project.name, project.id)
        return project
