"""gitEssay backend — AI router: settings, connectivity test, LangGraph agent."""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app import agent_graph, ai, schemas
from app.db import get_db
from app.models import AISettings

router = APIRouter(tags=["ai"])


def _settings(db: Session) -> AISettings:
    s = db.get(AISettings, 1)
    if s is None:
        s = AISettings(id=1)
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


def _mask(s: AISettings) -> dict:
    return {
        "provider_format": s.provider_format,
        "base_url": s.base_url,
        "model": s.model,
        "temperature": s.temperature,
        "max_input_tokens": s.max_input_tokens,
        "max_output_tokens": s.max_output_tokens,
        "vision_capable": bool(s.vision_capable),
        "embedding_model": s.embedding_model or "",
        "has_key": bool(s.api_key),
        "api_key": "",  # never return the real key to the browser
    }


@router.get("/ai/settings", response_model=schemas.AISettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return _mask(_settings(db))


@router.put("/ai/settings", response_model=schemas.AISettingsOut)
def put_settings(body: schemas.AISettingsIn, db: Session = Depends(get_db)):
    s = _settings(db)
    data = body.model_dump(exclude_none=True)
    for key, value in data.items():
        # api_key=None (omitted) keeps the existing key; "" clears it only if sent.
        setattr(s, key, value)
    db.commit()
    return _mask(s)


@router.post("/ai/test", response_model=schemas.TestResult)
def test_connection(body: schemas.AISettingsIn, db: Session = Depends(get_db)):
    s = _settings(db)
    overrides = body.model_dump(exclude_none=True)
    # Build a transient settings object with the overrides applied.
    merged = type("S", (), {})()
    for attr in ("provider_format", "base_url", "api_key", "model",
                 "temperature", "max_input_tokens", "max_output_tokens",
                 "vision_capable", "embedding_model"):
        setattr(merged, attr, overrides.get(attr, getattr(s, attr)))
    # Reasoning/thinking models spend tokens on thinking BEFORE any visible text,
    # so give the probe enough room to finish and emit a reply. 32 was too tight
    # and made every reasoner report a false "length" failure.
    merged.max_output_tokens = 1024
    if not (merged.base_url and merged.api_key and merged.model):
        return {"ok": False, "message": "base URL, API key, and model are all required"}
    try:
        out = ai.call_model(merged, "You are a connectivity test. Reply with the single word OK.", "ping")
        return {"ok": True, "message": f"OK — {merged.provider_format}/{merged.model} replied ({len(out)} chars)."}
    except ai.ModelEmptyResponse as e:
        # finish_reason=length still proves the endpoint is reachable and the key
        # works — the model just spent its budget on thinking. Treat as connected.
        if e.is_length:
            return {
                "ok": True,
                "message": (
                    f"Connected — {merged.provider_format}/{merged.model} responded "
                    "but hit the token cap on thinking (a reasoning model). Raise "
                    "Max output tokens for real edits."
                ),
            }
        return {"ok": False, "message": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}


@router.post("/agent/run")
async def agent_run(body: schemas.AgentRunRequest, db: Session = Depends(get_db)):
    """SSE stream of the LangGraph agent run (the only agent engine).

    Events (`data: {json}` envelope):
      {type:'thinking'|'text', delta} — reasoning / prose deltas
      {type:'step', step:{kind,query?,note?,hits?,at}} — read/search/remember chip
      {type:'patch', explanation, edits:[{search,replace}]} — propose_patch (terminal)
      {type:'ask', question, options:[...]} — ask_user (terminal)
      {type:'done'} / {type:'error', message}
    """
    # _settings does synchronous SQLAlchemy I/O — keep it off the event loop.
    s = await asyncio.to_thread(_settings, db)
    if not (s.base_url and s.api_key and s.model):
        raise HTTPException(
            status_code=400,
            detail="AI is not configured (set provider/key/model in settings)",
        )

    async def gen():
        try:
            async for ev in agent_graph.run_agent_stream(body, s, db):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001 — never let the generator die silently
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
