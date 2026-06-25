"""gitEssay backend — LLM gateway (OpenAI- and Anthropic-compatible).

Server-side port of the frontend's src/rewrite/llmClient.ts. Because these calls
run from the backend (not the browser) there's no CORS concern and no
`anthropic-dangerous-direct-browser-access` header needed; the API key lives
server-side (AISettings), never in the browser.
"""
import httpx


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
    if not isinstance(content, str) or not content.strip():
        finish = (choices[0] if choices else {}).get("finish_reason", "unknown")
        raise RuntimeError(f"model returned no text (finish_reason: {finish})")
    return content


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
        raise RuntimeError(
            f"model returned no text (stop_reason: {data.get('stop_reason', 'unknown')})"
        )
    return content
