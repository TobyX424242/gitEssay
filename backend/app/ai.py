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
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)


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


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x2E80 <= o <= 0x9FFF      # CJK radicals, kana, ideographs
        or 0xAC00 <= o <= 0xD7AF   # hangul syllables
        or 0xF900 <= o <= 0xFAFF   # CJK compatibility ideographs
        or 0xFF00 <= o <= 0xFFEF   # fullwidth forms
    )


def _approx_tokens(text: str) -> int:
    # A flat ceil(len/4) undercounts CJK ~4× (one ideograph ≈ one token, not a
    # quarter), over-truncating CJK documents. Count CJK chars individually.
    cjk = sum(1 for c in text if _is_cjk(c))
    return cjk + -(-(len(text) - cjk) // 4)


def fit_input(text: str, max_tokens: int) -> str:
    if max_tokens <= 0 or _approx_tokens(text) <= max_tokens:
        return text
    # Binary-search the longest prefix within the token budget (a flat
    # max_tokens*4 char cap is wrong for CJK — see _approx_tokens).
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _approx_tokens(text[:mid]) <= max_tokens:
            lo = mid
        else:
            hi = mid - 1
    cut = text[:lo]
    brk = max(cut.rfind("\n\n"), cut.rfind(". "))
    body = cut[:brk] if brk > len(cut) * 0.5 else cut
    return f"{body.rstrip()}\n\n[…input truncated to fit the token budget…]"


class _RetryableHTTP(RuntimeError):
    """Transient upstream failure worth another attempt (5xx / 429 / 408)."""


def _should_retry(e: BaseException) -> bool:
    # Transport errors (connect/timeout/read) and transient HTTP statuses.
    # 4xx like 401/400 are permanent — fail fast without burning quota.
    return isinstance(e, (httpx.TransportError, _RetryableHTTP))


@retry(
    retry=retry_if_exception(_should_retry),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    reraise=True,
)
def _post(url: str, **kwargs) -> httpx.Response:
    r = httpx.post(url, timeout=180, **kwargs)
    if r.status_code in (408, 425, 429) or r.status_code >= 500:
        raise _RetryableHTTP(f"HTTP {r.status_code}: {r.text[:500]}")
    return r


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
    r = _post(
        endpoint(s),
        json=body,
        headers={"Authorization": f"Bearer {s.api_key}"},
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
    r = _post(
        endpoint(s),
        json=body,
        headers={"x-api-key": s.api_key, "anthropic-version": "2023-06-01"},
    )
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
    data = r.json()
    blocks = data.get("content") or []
    content = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    if not content.strip():
        raise ModelEmptyResponse(data.get("stop_reason", "unknown"))
    return content
