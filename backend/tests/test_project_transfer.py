"""Project archive export/import: full-fidelity roundtrip + OS-style name
de-duplication + malformed-archive rejection."""
import io
import json
import os
import re
import zipfile

from sqlalchemy import text

from app.literature_search import FTS_TABLE, fts_enabled
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
from app.storage import literature_dir


def _populate(db, pid):
    """Give the project one of everything worth archiving."""
    now = now_ms()
    proj = db.get(Project, pid)
    c1 = Checkpoint(id=new_id(), project_id=pid, parent_id=None, source="init",
                    label="Initial", state=json.dumps({"v": 1}), created_at=now - 10)
    c2 = Checkpoint(id=new_id(), project_id=pid, parent_id=c1.id, source="manual",
                    label="Draft", state=json.dumps({"v": 2}), created_at=now)
    db.add_all([c1, c2])
    proj.current_checkpoint_id = c2.id
    db.add(Conversation(id=new_id(), project_id=pid, title="Chat A",
                        messages=json.dumps([{"id": "m1", "role": "user", "text": "hi"}]),
                        created_at=now, updated_at=now))
    lid = new_id()
    db.add(Literature(id=lid, project_id=pid, filename="paper.pdf", title="Paper",
                      status="ready", summary="A summary.", summary_status="ready",
                      embed_status="ok", page_count=3, char_count=100, chunk_count=1,
                      image_count=1, created_at=now))
    db.add(LiteratureChunk(id=new_id(), literature_id=lid, seq=0, heading="Intro",
                           text="attention is all you need",
                           embedding=json.dumps([0.1, 0.2, 0.3])))
    db.add(LiteratureImage(id=new_id(), literature_id=lid, seq=0, caption="Fig 1",
                           path=os.path.join("literature", lid, "images", "img_0.png"),
                           width=10, height=10))
    db.add(Memory(id=new_id(), project_id=pid, literature_id=lid,
                  content="remember this paper", created_at=now))
    db.commit()
    os.makedirs(os.path.join(literature_dir(lid), "images"), exist_ok=True)
    with open(os.path.join(literature_dir(lid), "original.pdf"), "wb") as fh:
        fh.write(b"%PDF-1.4 raw-bytes")
    with open(os.path.join(literature_dir(lid), "images", "img_0.png"), "wb") as fh:
        fh.write(b"\x89PNG fake")
    return lid


def _export(client, pid) -> bytes:
    r = client.get(f"/api/projects/{pid}/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert "attachment" in r.headers["content-disposition"]
    return r.content


def _import(client, data: bytes, name="archive.zip"):
    return client.post("/api/projects/import", files={"file": (name, data, "application/zip")})


def test_export_contains_everything(client, project, db):
    lid = _populate(db, project["id"])
    data = _export(client, project["id"])
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = set(zf.namelist())
        assert {"manifest.json", "checkpoints.json", "conversations.json",
                "memories.json", f"literature/{lid}/meta.json",
                f"literature/{lid}/chunks.json", f"literature/{lid}/images.json",
                f"literature/{lid}/original.pdf",
                f"literature/{lid}/images/img_0.png"} <= names
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["format"] == "gitessay-project-archive"
        assert manifest["version"] == 1
        assert manifest["project"]["name"] == project["name"]
        assert zf.read(f"literature/{lid}/original.pdf") == b"%PDF-1.4 raw-bytes"


def test_import_roundtrip_full_fidelity(client, project, db):
    old_lid = _populate(db, project["id"])
    data = _export(client, project["id"])

    r = _import(client, data)
    assert r.status_code == 200, r.text
    restored = r.json()
    assert restored["id"] != project["id"]
    # The source project still holds the name, so the copy is numbered.
    assert re.fullmatch(rf"{re.escape(project['name'])} \(\d+\)", restored["name"])

    cps = db.query(Checkpoint).filter_by(project_id=restored["id"]).all()
    assert len(cps) == 3  # the fixture's seeded init checkpoint + the 2 added
    current = db.get(Project, restored["id"]).current_checkpoint_id
    assert db.get(Checkpoint, current).label == "Draft"

    convs = db.query(Conversation).filter_by(project_id=restored["id"]).all()
    assert len(convs) == 1 and json.loads(convs[0].messages)[0]["text"] == "hi"
    assert db.get(Project, restored["id"]).active_conversation_id == convs[0].id

    lits = db.query(Literature).filter_by(project_id=restored["id"]).all()
    assert len(lits) == 1
    lit = lits[0]
    assert lit.id != old_lid
    assert lit.summary == "A summary." and lit.status == "ready"
    chunks = db.query(LiteratureChunk).filter_by(literature_id=lit.id).all()
    assert len(chunks) == 1
    assert json.loads(chunks[0].embedding) == [0.1, 0.2, 0.3]  # no re-embedding
    with open(os.path.join(literature_dir(lit.id), "original.pdf"), "rb") as fh:
        assert fh.read() == b"%PDF-1.4 raw-bytes"
    with open(os.path.join(literature_dir(lit.id), "images", "img_0.png"), "rb") as fh:
        assert fh.read() == b"\x89PNG fake"
    images = db.query(LiteratureImage).filter_by(literature_id=lit.id).all()
    assert len(images) == 1 and images[0].path.startswith(os.path.join("literature", lit.id))

    mems = db.query(Memory).filter_by(project_id=restored["id"]).all()
    assert len(mems) == 1 and mems[0].literature_id == lit.id  # remapped

    if fts_enabled():
        rows = db.execute(
            text(f"SELECT COUNT(*) FROM {FTS_TABLE} WHERE literature_id = :lid"),
            {"lid": lit.id},
        ).scalar()
        assert rows == 1  # searchable immediately, no re-parse


def test_import_duplicate_names_get_numbered(client, project, db):
    _populate(db, project["id"])
    data = _export(client, project["id"])
    # The source project itself holds the base name, so each import is
    # numbered; the suite shares one DB, so assert the pattern + strictly
    # increasing numbers rather than absolute values.
    names = [_import(client, data).json()["name"] for _ in range(3)]
    pat = re.compile(rf"{re.escape(project['name'])} \((\d+)\)")
    nums = [int(m.group(1)) for n in names if (m := pat.fullmatch(n))]
    assert len(nums) == 3 and nums == sorted(nums) and len(set(nums)) == 3


def test_import_rejects_garbage(client, db):
    r = _import(client, b"this is not a zip")
    assert r.status_code == 400
    # A zip without the manifest is not a gitEssay archive.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("random.txt", "hello")
    r = _import(client, buf.getvalue())
    assert r.status_code == 400
    # Zip-slip entries are refused.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../evil.txt", "x")
        zf.writestr("manifest.json", json.dumps(
            {"format": "gitessay-project-archive", "version": 1, "project": {"name": "E"}}))
    r = _import(client, buf.getvalue())
    assert r.status_code == 400
