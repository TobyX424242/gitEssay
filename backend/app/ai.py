"""gitEssay backend — LLM gateway (OpenAI- and Anthropic-compatible).

Server-side port of the frontend's src/rewrite/llmClient.ts. Because these calls
run from the backend (not the browser) there's no CORS concern and no
`anthropic-dangerous-direct-browser-access` header needed; the API key lives
server-side (AISettings), never in the browser.

Two surfaces:
  - call_model(...)         — blocking, returns the full text (used by /ai/test).
  - stream_model(...)       — async generator yielding normalized streaming
                              events (used by /chat/stream). Both providers are
                              normalized to {type: thinking|text|done|error}.
"""
import json
from typing import AsyncIterator

import httpx


class ModelEmptyResponse(RuntimeError):
    """The API responded (HTTP ok) but returned no visible text. Almost always
    `finish_reason=length` on a reasoning/thinking model whose thinking tokens
    consumed the whole max_tokens budget. Distinct from a real connectivity or
    auth failure (which raises an HTTP error), so the /ai/test probe can treat a
    length-truncated reply as a successful connection."""

    def __init__(self, reason: str):
        self.reason = reason
        self.is_length = reason in ("length", "max_tokens")
        super().__init__(f"model returned no text (finish_reason: {reason})")


def endpoint(s) -> str:
    base = (s.base_url or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("base_url is not configured")
    if s.provider_format == "anthropic":
        if base.endswith("/v1/messages"):
            return base
        if base.endswith("/v1"):
            return f"{base}/messages"
        return f"{base}/v1/messages"
    return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


def _approx_tokens(text: str) -> int:
    return -(-len(text) // 4)  # ceil(len/4)


def fit_input(text: str, max_tokens: int) -> str:
    if max_tokens <= 0 or _approx_tokens(text) <= max_tokens:
        return text
    cap = max_tokens * 4
    cut = text[:cap]
    brk = max(cut.rfind("\n\n"), cut.rfind(". "))
    body = cut[:brk] if brk > cap * 0.5 else cut
    return f"{body.rstrip()}\n\n[…input truncated to fit the token budget…]"


def call_model(s, system: str, user: str) -> str:
    if s.provider_format == "anthropic":
        return _anthropic(s, system, user)
    return _openai(s, system, user)


def _content_to_text(content) -> str:
    """OpenAI-compatible message content is usually a string, but some gateways
    return a list of content parts (e.g. [{"type":"text","text":"…"}]). Collapse
    either shape to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") in (None, "text")
        )
    return ""


def _openai(s, system: str, user: str) -> str:
    body = {
        "model": s.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": fit_input(user, s.max_input_tokens)},
        ],
        "temperature": s.temperature,
        "max_tokens": s.max_output_tokens,
    }
    r = httpx.post(
        endpoint(s),
        json=body,
        headers={"Authorization": f"Bearer {s.api_key}"},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
    data = r.json()
    choices = data.get("choices") or []
    content = (((choices[0] if choices else {}).get("message") or {}).get("content"))
    text = _content_to_text(content)
    if not text.strip():
        finish = (choices[0] if choices else {}).get("finish_reason", "unknown")
        raise ModelEmptyResponse(finish)
    return text


def _anthropic(s, system: str, user: str) -> str:
    body = {
        "model": s.model,
        "system": system,
        "messages": [{"role": "user", "content": fit_input(user, s.max_input_tokens)}],
        "temperature": s.temperature,
        "max_tokens": s.max_output_tokens,
    }
    r = httpx.post(
        endpoint(s),
        json=body,
        headers={"x-api-key": s.api_key, "anthropic-version": "2023-06-01"},
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
    data = r.json()
    blocks = data.get("content") or []
    content = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    if not content.strip():
        raise ModelEmptyResponse(data.get("stop_reason", "unknown"))
    return content


# --- streaming -------------------------------------------------------------
# Normalized events:
#   {"type": "thinking", "delta": "..."}  — reasoning text (reasoning_content /
#                                           Anthropic thinking_delta); shown live
#                                           in a collapsible "Thoughts" pane.
#   {"type": "text",     "delta": "..."}  — visible content (prose + actions).
#   {"type": "done"}                       — stream complete.
#   {"type": "error",    "message": "..."} — fatal; client should surface it.
def _ev(kind: str, **extra) -> dict:
    return {"type": kind, **extra}


async def stream_model(s, system: str, messages: list) -> AsyncIterator[dict]:
    """Async generator yielding normalized streaming events for one chat turn.

    `messages` is an OpenAI-style [{role, content}] array (user/assistant only —
    tool results are framed as user turns by the frontend so the same shape works
    for both provider formats). The system prompt is passed separately.
    """
    if s.provider_format == "anthropic":
        async for ev in _anthropic_stream(s, system, messages):
            yield ev
    else:
        async for ev in _openai_stream(s, system, messages):
            yield ev


async def _openai_stream(s, system: str, messages: list) -> AsyncIterator[dict]:
    body = {
        "model": s.model,
        "messages": [{"role": "system", "content": system}, *messages],
        "temperature": s.temperature,
        "max_tokens": s.max_output_tokens,
        "stream": True,
    }
    # timeout=None: streaming first-byte / inter-chunk gaps can exceed the
    # default pool timeout, especially on slow reasoning models.
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                endpoint(s),
                json=body,
                headers={"Authorization": f"Bearer {s.api_key}"},
            ) as r:
                if r.status_code >= 400:
                    raw = (await r.aread()).decode("utf-8", "replace")
                    yield _ev("error", message=f"HTTP {r.status_code}: {raw[:500]}")
                    return
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[len("data:") :].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        obj = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    choices = obj.get("choices") or []
                    delta = (choices[0].get("delta") if choices else {}) or {}
                    # Reasoning models (o-series, some gateways) expose reasoning
                    # via `reasoning_content`; surface it as thinking.
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                    if reasoning:
                        yield _ev("thinking", delta=reasoning)
                    if delta.get("content"):
                        yield _ev("text", delta=delta["content"])
    except httpx.HTTPError as e:
        yield _ev("error", message=f"network error: {e}")
        return
    yield _ev("done")


async def _anthropic_stream(s, system: str, messages: list) -> AsyncIterator[dict]:
    body = {
        "model": s.model,
        "system": system,
        "messages": messages,
        "temperature": s.temperature,
        "max_tokens": s.max_output_tokens,
        "stream": True,
    }
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                endpoint(s),
                json=body,
                headers={
                    "x-api-key": s.api_key,
                    "anthropic-version": "2023-06-01",
                },
            ) as r:
                if r.status_code >= 400:
                    raw = (await r.aread()).decode("utf-8", "replace")
                    yield _ev("error", message=f"HTTP {r.status_code}: {raw[:500]}")
                    return
                # Anthropic SSE: `event: <name>` then `data: {json}`. We only
                # need the data lines; each carries its own `type`.
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[len("data:") :].strip()
                    try:
                        obj = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    etype = obj.get("type")
                    if etype == "content_block_delta":
                        delta = obj.get("delta") or {}
                        dtype = delta.get("type")
                        if dtype == "text_delta" and delta.get("text"):
                            yield _ev("text", delta=delta["text"])
                        elif dtype == "thinking_delta" and delta.get("thinking"):
                            yield _ev("thinking", delta=delta["thinking"])
                    elif etype == "message_stop":
                        break
                    elif etype == "error":
                        err = (obj.get("error") or {}).get("message", "anthropic error")
                        yield _ev("error", message=err)
                        return
    except httpx.HTTPError as e:
        yield _ev("error", message=f"network error: {e}")
        return
    yield _ev("done")
