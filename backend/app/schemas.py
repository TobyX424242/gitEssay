"""gitEssay backend — Pydantic request/response schemas."""
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, field_serializer


# ---- projects -------------------------------------------------------------
class ProjectOut(BaseModel):
    id: str
    name: str
    current_checkpoint_id: Optional[str] = None
    active_conversation_id: Optional[str] = None
    created_at: int
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class ProjectCreate(BaseModel):
    name: Optional[str] = None


class ProjectRename(BaseModel):
    name: str


# ---- checkpoints ----------------------------------------------------------
class CheckpointOut(BaseModel):
    id: str
    project_id: str
    parent_id: Optional[str] = None
    state: dict[str, Any]
    source: str
    label: Optional[str] = None
    created_at: int

    model_config = ConfigDict(from_attributes=True)


class CheckpointCapture(BaseModel):
    state: dict[str, Any]
    label: Optional[str] = None
    # Mirrors the frontend's CheckpointSource union. Anything other than "auto"
    # is treated as durable by the capture endpoint.
    source: Literal["init", "manual", "auto", "restore", "ai-accept"] = "manual"
    skip_if_unchanged: bool = False


# ---- conversations --------------------------------------------------------
class ConversationOut(BaseModel):
    id: str
    project_id: str
    title: str
    messages: list[Any]
    created_at: int
    updated_at: int

    model_config = ConfigDict(from_attributes=True)


class ConversationCreate(BaseModel):
    title: Optional[str] = None


class SetActive(BaseModel):
    id: str


class ConversationPatch(BaseModel):
    title: Optional[str] = None
    messages: Optional[list[Any]] = None


class MessageAppend(BaseModel):
    messages: list[Any]
    title: Optional[str] = None


class MessageReplace(BaseModel):
    message: dict[str, Any]


class EditStatePatch(BaseModel):
    # Mirrors the frontend's ChatEditState union.
    state: Literal["pending", "applied", "rejected", "unlocatable", "stale", "reverted"]
    # "text" (default) targets message.edits[idx]; "eq" targets message.eqEdits[idx]
    # (an equation patch entry, which can also carry prevLatex / failReason);
    # "append" targets message.appendEdits[idx].
    kind: Literal["text", "eq", "append"] = "text"
    prev_latex: Optional[str] = None
    fail_reason: Optional[str] = None


# ---- memories (AI long-term, project/literature-scoped notes) -------------
class MemoryOut(BaseModel):
    id: str
    project_id: str
    literature_id: Optional[str] = None
    literature_title: Optional[str] = None  # joined, for display
    content: str
    created_at: int

    model_config = ConfigDict(from_attributes=True)


class MemoryCreate(BaseModel):
    content: str
    literature_id: Optional[str] = None  # NULL = project-wide note


# ---- literature (uploaded references: PDF/DOCX → chunks/images) -----------
class LiteratureOut(BaseModel):
    id: str
    project_id: str
    filename: str
    title: str
    status: str  # processing | ready | error
    error: Optional[str] = None
    page_count: int
    char_count: int
    chunk_count: int
    image_count: int
    note_count: int = 0
    # AI summary lifecycle: none → generating → ready | failed | skipped
    summary_status: str = "none"
    # Embedding indexing outcome: none | disabled (no model configured) | ok |
    # failed (keyword search only)
    embed_status: str = "none"
    # Parse progress 0..1 while processing (PDFs); null = indeterminate
    progress: Optional[float] = None
    # Two-tier parse metadata: engine that produced the chunks (edgeparse |
    # docling | null), auditor confidence (none | reliable | partial |
    # unreliable), live phase while processing, and the auditor's note.
    parse_engine: Optional[str] = None
    parse_confidence: str = "none"
    parse_phase: Optional[str] = None
    parse_eval_note: Optional[str] = None
    created_at: int

    model_config = ConfigDict(from_attributes=True)


class LiteratureImageOut(BaseModel):
    id: str
    seq: int
    caption: str
    width: int
    height: int

    model_config = ConfigDict(from_attributes=True)


class LiteratureDetail(LiteratureOut):
    images: list[LiteratureImageOut] = []
    outline: list[str] = []  # distinct chunk headings, in document order
    summary: Optional[str] = None


# ---- AI -------------------------------------------------------------------
class AISettingsOut(BaseModel):
    provider_format: str
    base_url: str
    model: str
    temperature: float
    max_input_tokens: int
    max_output_tokens: int
    vision_capable: bool
    embedding_model: str
    has_key: bool
    api_key: str = ""  # masked — empty unless a key is set

    @field_serializer("api_key")
    def _redact_api_key(self, value: str) -> str:
        # Defense in depth: even if this model is ever constructed straight
        # from the ORM row, the serialized payload never contains the key.
        return ""


class AISettingsIn(BaseModel):
    # Anything not exactly "anthropic" is spoken to as OpenAI — reject typos at
    # the door instead of silently using the wrong protocol.
    provider_format: Optional[Literal["openai", "anthropic"]] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_input_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None
    # User-declared model capability flags.
    vision_capable: Optional[bool] = None
    embedding_model: Optional[str] = None


class TestResult(BaseModel):
    ok: bool
    message: str


# --- agent (LangGraph) -----------------------------------------------------
class AgentRunRequest(BaseModel):
    """One agent run over the LangGraph backend. The frontend sends the live
    document snapshot (sentinel-laden paragraphs) because the backend has no live
    editor; the agent reads/searches that snapshot via tools."""
    project_id: str
    instruction: str
    mode: Literal["selection", "document"] = "document"
    selection_text: str = ""
    doc_paragraphs: list[str]
    # The document's LaTeX equations: [{nonce, inline, latex}] — each [[EQ:nonce]]
    # token in doc_paragraphs maps to one entry carrying its raw LaTeX source.
    doc_equations: list[dict[str, Any]] = []
    history: list[dict[str, Any]] = []  # [{role: 'user'|'assistant', content: str}]
    memory_enabled: bool = False
