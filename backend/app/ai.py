"""gitEssay backend — LLM gateway (OpenAI- and Anthropic-compatible).

Server-side port of the frontend's src/rewrite/llmClient.ts. Because these calls
run from the backend (not the browser) there's no CORS concern and no
`anthropic-dangerous-direct-browser-access` header needed; the API key lives
server-side (AISettings), never in the browser.

call_model(...) is the blocking single-shot surface, used by /ai/test and the
literature summarizer. The chat agent runs through LangGraph (agent_graph.py,
via langchain) and does not use this module.
"""
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
