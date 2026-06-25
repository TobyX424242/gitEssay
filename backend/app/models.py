"""gitEssay backend — ORM models (SQLAlchemy)."""
import json
import time
import uuid

from sqlalchemy import Column, Float, ForeignKey, Integer, String, Text

from app.db import Base

SCHEMA_VERSION = 1
LEXICAL_VERSION = "0.45.1-nightly.20260623.0"

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
    schema_version = Column(Integer, nullable=False, default=SCHEMA_VERSION)
    lexical_version = Column(String, nullable=False, default=LEXICAL_VERSION)
    state = Column(Text, nullable=False)  # JSON string (SerializedEditorState)
    markdown = Column(Text, nullable=False, default="")
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
