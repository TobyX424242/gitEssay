"""gitEssay backend — LangChain chat-model factory.

Builds a streaming LangChain chat model from the app's single-row AISettings,
preserving the custom-base-URL config (OpenAI-compatible or Anthropic-native).
The model is consumed by the LangGraph agent (agent_graph.py); tool binding
happens in the graph. Server-side keys stay server-side — the browser never sees
api_key.
"""
import threading

from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI

from app.models import AISettings

# Building a chat model per request re-creates the HTTP client and provider
# bookkeeping every time. This is a single-user app with one settings row, so
# cache the built model for the current config and drop it the moment any
# settings field changes (the key below covers every build_model input).
_cache: dict[tuple, object] = {}
_cache_lock = threading.Lock()


def build_model_cached(s: AISettings):
    key = (
        s.provider_format,
        s.base_url,
        s.api_key,
        s.model,
        s.temperature,
        s.max_output_tokens,
    )
    with _cache_lock:
        model = _cache.get(key)
        if model is None:
            model = build_model(s)
            _cache.clear()
            _cache[key] = model
    return model


def _norm_anthropic_base(base: str) -> str:
    """ChatAnthropic expects the API root and appends /v1/messages itself, so
    strip any trailing /v1 or /v1/messages the user may have stored (inverse of
    app.ai.endpoint, which builds the full path for the raw httpx call)."""
    b = (base or "").strip().rstrip("/")
    for suf in ("/v1/messages", "/v1"):
        if b.endswith(suf):
            b = b[: -len(suf)]
            break
    return b or "https://api.anthropic.com"


def build_model(s: AISettings):
    """Construct a streaming LangChain chat model from AISettings.

    Raises RuntimeError if base_url/api_key/model are not all set (same gate as
    app.ai). Tool-calling support is a property of the chosen model/endpoint —
    bind_tools may fail later on models that lack it; the SSE bridge surfaces
    that as an error event.
    """
    if not (s.base_url and s.api_key and s.model):
        raise RuntimeError("AI is not configured (set provider/key/model in settings)")

    common = dict(
        model=s.model,
        api_key=s.api_key,
        temperature=s.temperature,
        max_tokens=s.max_output_tokens,
        streaming=True,
    )
    if s.provider_format == "anthropic":
        return ChatAnthropic(base_url=_norm_anthropic_base(s.base_url), **common)
    return ChatOpenAI(base_url=(s.base_url or None), **common)
