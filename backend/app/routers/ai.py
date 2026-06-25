"""gitEssay backend — AI router: settings, chat gateway, test, agent stub."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import ai, schemas
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
                 "temperature", "max_input_tokens", "max_output_tokens"):
        setattr(merged, attr, overrides.get(attr, getattr(s, attr)))
    merged.max_output_tokens = 32
    if not (merged.base_url and merged.api_key and merged.model):
        return {"ok": False, "message": "base URL, API key, and model are all required"}
    try:
        out = ai.call_model(merged, "You are a connectivity test. Reply with the single word OK.", "ping")
        return {"ok": True, "message": f"OK — {merged.provider_format}/{merged.model} replied ({len(out)} chars)."}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}


@router.post("/chat", response_model=schemas.ChatResponse)
def chat(body: schemas.ChatRequest, db: Session = Depends(get_db)):
    s = _settings(db)
    if not (s.base_url and s.api_key and s.model):
        raise HTTPException(status_code=400, detail="AI is not configured (set provider/key/model in settings)")
    try:
        content = ai.call_model(s, body.system, body.user)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e))
    return {"content": content}


@router.post("/agent/run")
def agent_run():
    """Stub — the future LangGraph agent (Phase 6) lives here."""
    raise HTTPException(status_code=501, detail="agent not implemented yet (LangGraph phase)")
