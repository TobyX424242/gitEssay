"""gitEssay backend — ORM models (SQLAlchemy)."""
import time
import uuid
from sqlalchemy import Boolean, Column, Float, ForeignKey, Integer, String, Text

from app.db import Base

# A valid empty Lexical SerializedEditorState (root + one empty paragraph).
EMPTY_STATE = {
    "root": {
        "children": [
            {
                "children": [],
                "direction": None,
                "format": "",
                "indent": 0,
                "type": "paragraph",
                "version": 1,
            }
        ],
        "direction": None,
        "format": "",
        "indent": 0,
        "type": "root",
        "version": 1,
    }
}


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return str(uuid.uuid4())


def auto_slot_id(project_id: str) -> str:
    """Stable id for a project's single rolling auto checkpoint."""
    return f"{project_id}::auto"


class Project(Base):
    __tablename__ = "projects"
    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="Untitled")
    current_checkpoint_id = Column(String, nullable=True)
    active_conversation_id = Column(String, nullable=True)
    created_at = Column(Integer, nullable=False, default=now_ms)
    updated_at = Column(Integer, nullable=False, default=now_ms)


class Checkpoint(Base):
    __tablename__ = "checkpoints"
    id = Column(String, primary_key=True)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id = Column(String, nullable=True)
    state = Column(Text, nullable=False)  # JSON string (SerializedEditorState)
    source = Column(String, nullable=False, default="manual")  # init|manual|auto|ai-accept
    label = Column(String, nullable=True)
    created_at = Column(Integer, nullable=False, default=now_ms, index=True)


class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(String, primary_key=True)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title = Column(String, nullable=False, default="New conversation")
    messages = Column(Text, nullable=False, default="[]")  # JSON string
    created_at = Column(Integer, nullable=False, default=now_ms)
    updated_at = Column(Integer, nullable=False, default=now_ms, index=True)


class Memory(Base):
    """AI's long-term, project-scoped notes — things it wants to remember about
    this project across conversations. Injected into the agent's context when the
    user has long-term memory enabled; the agent can add notes via the `remember`
    action.

    `literature_id` is NULL for project-wide notes; when set, the note is scoped
    to one literature item (the agent's per-paper reading notes) and is injected
    into subagent context for that paper instead of the main prompt."""
    __tablename__ = "memories"
    id = Column(String, primary_key=True)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    literature_id = Column(
        String, ForeignKey("literature.id", ondelete="CASCADE"), nullable=True, index=True
    )
    content = Column(Text, nullable=False)
    created_at = Column(Integer, nullable=False, default=now_ms, index=True)


class Literature(Base):
    """One uploaded reference document (PDF/DOCX) parsed by docling.

    The original file and extracted images live on disk under
    <DATA_DIR>/literature/{id}/ (see literature_ingest); this row tracks the
    parse status and denormalized counts. status: processing → ready | error."""
    __tablename__ = "literature"
    id = Column(String, primary_key=True)
    project_id = Column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    filename = Column(String, nullable=False)
    title = Column(String, nullable=False, default="")
    status = Column(String, nullable=False, default="processing")
    error = Column(Text, nullable=True)
    # AI-generated summary (map-reduce over chunks, see literature_summary.py).
    # summary_status: none → generating → ready | failed | skipped (AI unconfigured)
    summary = Column(Text, nullable=True)
    summary_status = Column(String, nullable=False, default="none")
    # Parse progress 0..1 (PDFs, from per-segment conversion); NULL =
    # indeterminate (DOCX, or not started). Meaningful only while processing.
    progress = Column(Float, nullable=True)
    page_count = Column(Integer, nullable=False, default=0)
    char_count = Column(Integer, nullable=False, default=0)
    chunk_count = Column(Integer, nullable=False, default=0)
    image_count = Column(Integer, nullable=False, default=0)
    created_at = Column(Integer, nullable=False, default=now_ms, index=True)


class LiteratureChunk(Base):
    """A retrievable text segment of a literature item. `embedding` is a JSON
    float array when an embedding model is configured, else NULL (FTS-only)."""
    __tablename__ = "literature_chunks"
    id = Column(String, primary_key=True)
    literature_id = Column(
        String, ForeignKey("literature.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq = Column(Integer, nullable=False)  # order within the document
    heading = Column(String, nullable=False, default="")  # section path, e.g. "3.2 Methods"
    text = Column(Text, nullable=False)
    embedding = Column(Text, nullable=True)


class LiteratureImage(Base):
    """A figure/table image extracted from a literature item (docling pictures)."""
    __tablename__ = "literature_images"
    id = Column(String, primary_key=True)
    literature_id = Column(
        String, ForeignKey("literature.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq = Column(Integer, nullable=False)  # order within the document
    caption = Column(String, nullable=False, default="")
    path = Column(String, nullable=False)  # relative to DATA_DIR
    width = Column(Integer, nullable=False, default=0)
    height = Column(Integer, nullable=False, default=0)


class AISettings(Base):
    __tablename__ = "ai_settings"
    id = Column(Integer, primary_key=True)  # always 1 (single-row, single-user)
    provider_format = Column(String, nullable=False, default="openai")
    base_url = Column(String, nullable=False, default="https://api.openai.com/v1")
    api_key = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="gpt-4o-mini")
    temperature = Column(Float, nullable=False, default=0.7)
    max_input_tokens = Column(Integer, nullable=False, default=16000)
    max_output_tokens = Column(Integer, nullable=False, default=8000)
    # User-declared model capability: may the agent send images (literature
    # figures) to the model? Off by default — when off, read_figure returns
    # caption/context text only.
    vision_capable = Column(Boolean, nullable=False, default=False)
    # Optional embedding model for semantic literature search, served from the
    # same OpenAI-compatible base_url (/embeddings). Empty = FTS keyword-only.
    embedding_model = Column(String, nullable=False, default="")
