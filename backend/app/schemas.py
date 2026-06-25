"""gitEssay backend — Pydantic request/response schemas."""
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


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
    schema_version: int
    lexical_version: str
    state: dict[str, Any]
    markdown: str
    source: str
    label: Optional[str] = None
    created_at: int

    model_config = ConfigDict(from_attributes=True)


class CheckpointCapture(BaseModel):
    state: dict[str, Any]
    markdown: str = ""
    label: Optional[str] = None
    source: str = "manual"
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
    state: str


# ---- AI -------------------------------------------------------------------
class ChatRequest(BaseModel):
    system: str
    user: str


class ChatResponse(BaseModel):
    content: str


class AISettingsOut(BaseModel):
    provider_format: str
    base_url: str
    model: str
    temperature: float
    max_input_tokens: int
    max_output_tokens: int
    has_key: bool
    api_key: str = ""  # masked — empty unless a key is set


class AISettingsIn(BaseModel):
    provider_format: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_input_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None


class TestResult(BaseModel):
    ok: bool
    message: str
