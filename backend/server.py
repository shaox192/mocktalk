"""
MockTalk — FastAPI entry point
===============================
Slim server that wires up the WebSocket presentation session and a
REST endpoint for API key validation. All heavy logic lives in
present_session.py, transcriber.py, llm_utils.py, and config.py.

Start the server:
  uvicorn server:app --reload --host 0.0.0.0 --port 8000
"""

import json
import os

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI
from anthropic import AsyncAnthropic
from google import genai
from pydantic import BaseModel

import config
import llm_utils
import transcriber
import present_session


# ── Provider mapping for AI coach models ─────────────────────────────────────
# Maps model ID → provider name. Must stay in sync with frontend models.ts.

AI_COACH_PROVIDER: dict[str, str] = {
    "gpt-4o": "openai",
    "gpt-5.2": "openai",
    "gpt-5.4": "openai",
    "gpt-5.4-mini": "openai",
    "gemini-3-flash-preview": "google",
    "gemini-3.1-pro-preview": "google",
    "claude-sonnet-4-5-20250929": "anthropic",
    "claude-sonnet-4-6": "anthropic",
    "claude-opus-4-6": "anthropic",
}

# ── Provider mapping for transcriber models ──────────────────────────────────

TRANSCRIBER_INFO: dict[str, tuple[str, str]] = {
    # id --> (provider, actual_model_id)
    "openai": ("openai", "whisper-1"),
    "groq": ("groq", "whisper-large-v3-turbo"),
}

# Only want local storage directories on my laptop.
if config.RUN_ENVIRONMENT == "development":
    config.TMP_DIR.mkdir(exist_ok=True)
    config.SLIDES_DIR.mkdir(exist_ok=True)
    config.CONVERSATIONS_DIR.mkdir(exist_ok=True)

# ── App setup ─────────────────────────────────────────────────────────────────

app = FastAPI(title="MockTalk API")

_env_origins = os.getenv("ALLOWED_ORIGINS", "")
_allowed_origins = (
    [o.strip() for o in _env_origins.split(",") if o.strip()]
    if _env_origins
    else ["http://localhost:3000"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Session config builder ───────────────────────────────────────────────────

def _build_session_config(settings: dict) -> present_session.SessionConfig:
    """
    Parse the client_settings dict sent by the frontend on WebSocket open.
    Build API clients and a transcriber based on the (already-validated) keys.
    """

    # ── AI Coach ──────────────────────────────────────────────────────────
    ai_coach_model: str = settings.get("aiCoachModel", "gpt-4o")
    fake_session: bool = (ai_coach_model == "none")
    llm_client: object | None = None
    llm_provider: str = AI_COACH_PROVIDER.get(ai_coach_model, "openai")

    if not fake_session:
        client_ai_key = settings.get("aiCoachApiKey", "").strip()
        if client_ai_key:
            if llm_provider == "anthropic":
                llm_client = AsyncAnthropic(api_key=client_ai_key)
            elif llm_provider == "google":
                llm_client = genai.Client(api_key=client_ai_key)
            else:
                llm_client = AsyncOpenAI(api_key=client_ai_key)
        else:
            fake_session = True

    # ── Transcriber ───────────────────────────────────────────────────────
    transcriber_model: str = settings.get("transcriberModel", "groq")
    client_transcriber_key: str = settings.get("transcriberApiKey", "").strip()
    t: transcriber.Transcriber | None = None

    transcriber_info = TRANSCRIBER_INFO.get(transcriber_model)
    if transcriber_info and client_transcriber_key:
        t_provider, t_model_id = transcriber_info
        if t_provider == "groq":
            groq_client = AsyncOpenAI(
                api_key=client_transcriber_key,
                base_url="https://api.groq.com/openai/v1",
            )
            t = transcriber.GroqTranscriber(groq_client, model=t_model_id)
        else:
            oai_client = AsyncOpenAI(api_key=client_transcriber_key)
            t = transcriber.OpenAITranscriber(oai_client, model=t_model_id)

    elif transcriber_model == "local" and transcriber._WHISPER_IMPORT_OK:
        t = transcriber.LocalTranscriber(transcriber._load_whisper_model())

    # transcriber_model == "none"

    transcription_available: bool = t is not None

    if not transcription_available:
        fake_session = True

    # ── Slide change sensitivity (1–10) ──────────────────────
    # for users, the sensitivity number higher = more sensitive.
    sensitivity: int = settings.get("slideChangeSensitivity", 5)
    slide_diff_threshold: float = (10 - (sensitivity - 1)) / 10.0 * 15 # Max threshold is 15, min is 1.5, at sensitivity 5 threshold is 7.5

    # ── Interruption frequency (1–10) ─────────
    frequency: int = settings.get("interruptionFrequency", 5)
    eval_interval: float = (10 - (frequency - 1)) / 10.0 * (50 - 15) + 25 # Max interval is 50s, min is 25s, at frequency 5 interval is 37.5s

    # ── Presentation description ─────────────────────────────────────────
    presentation_description: str = settings.get("presentationDescription", "").strip()

    print(
        f"[CONF] session config: fake={fake_session}, "
        f"transcriber={transcriber_model}, "
        f"threshold={slide_diff_threshold:.1f}, "
        f"eval_interval={eval_interval:.0f}s"
    )

    return present_session.SessionConfig(
        fake_session=fake_session,
        llm_client=llm_client,
        llm_provider=llm_provider,
        ai_coach_model=ai_coach_model,
        transcriber_instance=t,
        transcription_available=transcription_available,
        slide_diff_threshold=slide_diff_threshold,
        eval_interval=eval_interval,
        presentation_description=presentation_description,
    )


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    print("[WS] client connected")

    try:
        first_msg = await ws.receive_text()
        first_data = json.loads(first_msg)
        if first_data.get("type") != "client_settings":
            print("[WS] first message was not client_settings — using defaults")
            first_data = {}
        else:
            print(f"[WS] received client_settings: "
                  f"{ {k: ('***' if 'key' in k.lower() else v) for k, v in first_data.items()} }")
    except Exception as exc:
        print(f"[WS] error reading client_settings: {exc} — using defaults")
        first_data = {}

    cfg = _build_session_config(first_data)

    await ws.send_text(json.dumps({
        "type": "session_config", "fake_session": cfg.fake_session
    }))
    if not cfg.transcription_available:
        await ws.send_text(json.dumps({"type": "transcription_unavailable"}))

    # ── Sanity check: verify the AI coach is reachable before starting!! 
    if not cfg.fake_session and cfg.llm_client is not None:
        try:
            await llm_utils.coach_talk(
                client=cfg.llm_client,
                provider=cfg.llm_provider,
                messages=[{"role": "user", "content": "What is the capital of Iceland? Respond with ONE word."}],
                which_model=cfg.ai_coach_model,
                max_tokens=16,
            )
            await ws.send_text(json.dumps({"type": "sanity_check", "status": "ok"}))
        except Exception as exc:
            print(f"[WS] sanity check failed: {exc}")
            await ws.send_text(json.dumps({
                "type": "sanity_check", "status": "error",
                "message": f"AI coach sanity check failed: {exc}",
            }))

    session = present_session.PresentationSession(ws, cfg)
    await session.run()


# ── Environment check endpoint ────────────────────────────────────────────────

@app.get("/api/check-local-env")
async def check_local_env():
    """Return whether the server supports local transcription."""
    is_local = config.RUN_ENVIRONMENT == "development"
    return {
        "is_local": is_local,
        "whisper_available": is_local and transcriber._WHISPER_IMPORT_OK,
    }


# ── API key validation endpoint ───────────────────────────────────────────────

class ValidateKeysRequest(BaseModel):
    provider: str   # "openai", "groq", "anthropic", or "google"
    api_key: str
    model: str      # e.g. "gpt-4o", "claude-sonnet-4-5-20250514", "gemini-3-flash"


@app.post("/api/validate-keys")
async def validate_keys(req: ValidateKeysRequest):
    """
    Validate a user-provided API key and check model availability.
    Returns {"key_valid": bool, "model_valid": bool, "error": str | None}.
    """
    try:
        if req.provider == "openai":
            client = AsyncOpenAI(api_key=req.api_key)
            models_response = await client.models.list()
            available = {m.id for m in models_response.data}
            model_valid = req.model in available

        elif req.provider == "groq":
            client = AsyncOpenAI(
                api_key=req.api_key,
                base_url="https://api.groq.com/openai/v1",
            )
            models_response = await client.models.list()
            available = {m.id for m in models_response.data}
            model_valid = req.model in available

        elif req.provider == "anthropic":
            client = AsyncAnthropic(api_key=req.api_key)
            models_response = await client.models.list()
            available = {m.id for m in models_response.data}
            model_valid = req.model in available

        elif req.provider == "google":
            client = genai.Client(api_key=req.api_key)
            # google-genai sdk models.list() returns Model objects with .name like THIS: "models/gemini-3-flash"
            models_response = client.models.list()
            available = set()
            for m in models_response:
                # m.name is e.g. "models/gemini-3-flash" extract the model id
                name = m.name if isinstance(m.name, str) else str(m.name)
                available.add(name.removeprefix("models/"))
            model_valid = req.model in available

        else:
            return {"key_valid": False, "model_valid": False, "error": f"Unknown provider: {req.provider}"}

        return {
            "key_valid": True,
            "model_valid": model_valid,
            "error": None if model_valid else f"Model '{req.model}' not found for this API key",
        }

    except Exception:
        return {
            "key_valid": False,
            "model_valid": False,
            "error": "API KEY invalid. Please try again.",
        }
