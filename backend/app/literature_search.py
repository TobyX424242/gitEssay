"""gitEssay backend — hybrid retrieval over literature chunks.

Two ranking signals, fused with Reciprocal Rank Fusion (RRF, k=60):

- **Keyword**: SQLite FTS5 (`literature_fts`, built at app startup in
  main._migrate). Always available. When the environment lacks FTS5, degrades
  to a LIKE scan so search still works.
- **Semantic** (optional): when `AISettings.embedding_model` is set (OpenAI-
  compatible `/embeddings` on the configured base_url, i.e. provider_format
  "openai"), chunks carry JSON embeddings and the query is embedded at search
  time. Without it, keyword-only.

Everything is synchronous: ingestion runs on a background thread and the
agent's tools node runs in LangGraph's thread executor.
"""
import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

import httpx
import numpy as np
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.db import engine
from app.models import AISettings, Literature, LiteratureChunk

log = logging.getLogger(__name__)

FTS_TABLE = "literature_fts"
FTS_DDL = (
    f"CREATE VIRTUAL TABLE IF NOT EXISTS {FTS_TABLE} USING fts5("
    "text, heading, literature_id UNINDEXED, chunk_id UNINDEXED)"
)

_EMBED_BATCH = 32
_FTS_CANDIDATES = 20
_VEC_CANDIDATES = 20
_RRF_K = 60
READ_CHAR_CAP = 8000

_fts_ok: Optional[bool] = None


@dataclass
class Hit:
    chunk_id: str
    literature_id: str
    title: str
    heading: str
    text: str


# --- FTS housekeeping ---------------------------------------------------------
def ensure_fts_table() -> None:
    """Create the FTS5 virtual table if the SQLite build supports it (called
    once at startup; sets the process-global availability flag)."""
    global _fts_ok
    try:
        with engine.connect() as conn:
            conn.execute(text(FTS_DDL))
            conn.commit()
        _fts_ok = True
    except Exception:  # noqa: BLE001 — no FTS5 in this SQLite build
        log.warning("FTS5 unavailable — literature search falls back to LIKE")
        _fts_ok = False


def fts_enabled() -> bool:
    global _fts_ok
    if _fts_ok is None:
        ensure_fts_table()
    return bool(_fts_ok)


def index_chunk_fts(db: Session, literature_id: str, chunk_id: str, heading: str, body: str) -> None:
    db.execute(
        text(
            f"INSERT INTO {FTS_TABLE} (text, heading, literature_id, chunk_id) "
            "VALUES (:t, :h, :lid, :cid)"
        ),
        {"t": body, "h": heading, "lid": literature_id, "cid": chunk_id},
    )


def delete_literature_fts(db: Session, literature_id: str) -> None:
    if fts_enabled():
        db.execute(
            text(f"DELETE FROM {FTS_TABLE} WHERE literature_id = :lid"),
            {"lid": literature_id},
        )


# --- embeddings ----------------------------------------------------------------
def embed_texts(texts: list[str], settings: Optional[AISettings]) -> Optional[list[list[float]]]:
    """Embed texts via the OpenAI-compatible /embeddings endpoint. Returns None
    when unconfigured (no model set, non-OpenAI provider, no key) or on any
    failure — embedding is an enhancement, never a blocker."""
    model = ((settings.embedding_model if settings else "") or "").strip()
    if not texts or not settings or not model:
        return None
    if settings.provider_format != "openai" or not settings.api_key or not settings.base_url:
        return None
    url = settings.base_url.rstrip("/") + "/embeddings"
    try:
        out: list[list[float]] = []
        for i in range(0, len(texts), _EMBED_BATCH):
            batch = texts[i : i + _EMBED_BATCH]
            r = httpx.post(
                url,
                headers={"Authorization": f"Bearer {settings.api_key}"},
                json={"model": model, "input": batch},
                timeout=120,
            )
            if r.status_code >= 400:
                log.warning("embeddings HTTP %s: %s", r.status_code, r.text[:200])
                return None
            data = sorted(r.json().get("data", []), key=lambda d: d.get("index", 0))
            if len(data) != len(batch):
                return None
            out.extend(d["embedding"] for d in data)
        return out
    except Exception:  # noqa: BLE001
        log.exception("embedding request failed")
        return None


# --- search ---------------------------------------------------------------------
def _fts_ranking(
    db: Session, project_id: str, query: str, literature_id: Optional[str]
) -> list[str]:
    terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)[:10]
    if not terms:
        return []
    match = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
    # Project scoping is mandatory: the FTS table holds chunks of EVERY
    # project, and the hydration query in search_chunks filters chunk ids
    # only — without this subquery a search would return other projects'
    # papers (the LIKE/vector paths scope by project already).
    sql = (
        f"SELECT chunk_id FROM {FTS_TABLE} WHERE {FTS_TABLE} MATCH :match"
        " AND literature_id IN (SELECT id FROM literature WHERE project_id = :pid)"
        + (" AND literature_id = :lid" if literature_id else "")
        + " ORDER BY bm25(" + FTS_TABLE + ") LIMIT :lim"
    )
    params = {"match": match, "pid": project_id, "lim": _FTS_CANDIDATES}
    if literature_id:
        params["lid"] = literature_id
    return [r[0] for r in db.execute(text(sql), params).all()]


def _like_ranking(db: Session, project_id: str, query: str, literature_id: Optional[str]) -> list[str]:
    """FTS-less fallback: substring scan, first-come order. Filtering and the
    candidate cap are pushed into SQL so we never load the whole chunks table."""
    terms = [t.lower() for t in re.findall(r"[\w-]+", query, flags=re.UNICODE)[:6]]
    if not terms:
        return []
    q = (
        db.query(LiteratureChunk.id)
        .join(Literature, Literature.id == LiteratureChunk.literature_id)
        .filter(Literature.project_id == project_id)
    )
    if literature_id:
        q = q.filter(LiteratureChunk.literature_id == literature_id)
    q = q.filter(
        or_(*[func.lower(LiteratureChunk.text).contains(t, autoescape=True) for t in terms])
    )
    rows = (
        q.order_by(LiteratureChunk.literature_id, LiteratureChunk.seq)
        .limit(_FTS_CANDIDATES)
        .all()
    )
    return [r[0] for r in rows]


def _vector_ranking(
    db: Session, settings: Optional[AISettings], project_id: str, query: str, literature_id: Optional[str]
) -> list[str]:
    embedded = embed_texts([query], settings)
    if not embedded:
        return []
    q = np.asarray(embedded[0], dtype=np.float32)
    q_rows = (
        db.query(LiteratureChunk)
        .join(Literature, Literature.id == LiteratureChunk.literature_id)
        .filter(Literature.project_id == project_id, LiteratureChunk.embedding.isnot(None))
    )
    if literature_id:
        q_rows = q_rows.filter(LiteratureChunk.literature_id == literature_id)
    # Cosine ranking needs every candidate vector, so a SQL LIMIT is impossible
    # without an ANN index — but scoping to one paper stays in SQL.
    rows = q_rows.all()
    qn = np.linalg.norm(q)
    scored: list[tuple[str, float]] = []
    for row in rows:
        try:
            v = np.asarray(json.loads(row.embedding), dtype=np.float32)
        except Exception:  # noqa: BLE001 — skip a corrupt embedding row
            continue
        denom = float(qn * np.linalg.norm(v))
        scored.append((row.id, float(np.dot(q, v) / denom) if denom else 0.0))
    scored.sort(key=lambda kv: kv[1], reverse=True)
    return [cid for cid, _ in scored[:_VEC_CANDIDATES]]


def _rrf_merge(rankings: list[list[str]]) -> list[str]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for pos, cid in enumerate(ranking):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (_RRF_K + pos + 1)
    return sorted(scores, key=lambda c: scores[c], reverse=True)


def search_chunks(
    db: Session,
    project_id: str,
    query: str,
    literature_id: Optional[str] = None,
    k: int = 6,
    settings: Optional[AISettings] = None,
) -> list[Hit]:
    """Hybrid search over a project's literature chunks (RRF of keyword +
    semantic rankings; whichever signal is available)."""
    keyword = (
        _fts_ranking(db, project_id, query, literature_id)
        if fts_enabled()
        else _like_ranking(db, project_id, query, literature_id)
    )
    vector = _vector_ranking(db, settings, project_id, query, literature_id)
    merged = _rrf_merge([r for r in (keyword, vector) if r])[:k]
    if not merged:
        return []
    rows = (
        db.query(LiteratureChunk, Literature.title)
        .join(Literature, Literature.id == LiteratureChunk.literature_id)
        .filter(LiteratureChunk.id.in_(merged))
        .all()
    )
    by_id = {c.id: (c, t) for c, t in rows}
    return [
        Hit(chunk_id=cid, literature_id=c.literature_id, title=t, heading=c.heading, text=c.text)
        for cid in merged
        if cid in by_id
        for c, t in [by_id[cid]]
    ]


# --- structured reading -----------------------------------------------------------
def read_section(
    db: Session, literature_id: str, heading_substr: Optional[str] = None
) -> tuple[list[str], str]:
    """Returns (outline, body). Body = the chunks whose heading contains
    `heading_substr` (case-insensitive); with no filter, the document opening.
    Capped at READ_CHAR_CAP. The outline lets the agent navigate long papers."""
    chunks = (
        db.query(LiteratureChunk)
        .filter_by(literature_id=literature_id)
        .order_by(LiteratureChunk.seq)
        .all()
    )
    outline: list[str] = []
    for c in chunks:
        if c.heading and c.heading not in outline:
            outline.append(c.heading)
    if heading_substr:
        q = heading_substr.strip().lower()
        selected = [c for c in chunks if q in c.heading.lower()]
    else:
        selected = chunks
    body_parts: list[str] = []
    total = 0
    for c in selected:
        block = f"[{c.heading}]\n{c.text}" if c.heading else c.text
        if total + len(block) > READ_CHAR_CAP:
            remaining = READ_CHAR_CAP - total
            if remaining > 400:
                body_parts.append(block[:remaining])
                total += remaining
            break
        body_parts.append(block)
        total += len(block)
    return outline, "\n\n".join(body_parts)


def literature_index(db: Session, project_id: str, cap: int = 20) -> list[Literature]:
    """Ready literature for prompt injection / the list tool, oldest first."""
    return (
        db.query(Literature)
        .filter_by(project_id=project_id, status="ready")
        .order_by(Literature.created_at.asc())
        .limit(cap)
        .all()
    )
