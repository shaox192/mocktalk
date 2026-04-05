import asyncio
import base64
import datetime
import json
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import WebSocket, WebSocketDisconnect
import config
import transcriber as transcriber_mod
import llm_utils


@dataclass
class SessionConfig:
    fake_session: bool
    llm_client: object | None              # AsyncOpenAI, AsyncAnthropic, or genai.Client
    llm_provider: str                      # "openai", "anthropic", or "google"
    ai_coach_model: str                    # e.g. "gpt-4o"
    transcriber_instance: Optional[transcriber_mod.Transcriber]
    transcription_available: bool
    slide_diff_threshold: float
    eval_interval: float
    presentation_description: str


class PresentationSession:
    #TODO: refactor? this is huge
    def __init__(self, ws: WebSocket, cfg: SessionConfig):
        self.ws = ws
        self.fake_session = cfg.fake_session
        self.llm_client = cfg.llm_client
        self.llm_provider = cfg.llm_provider
        self.ai_coach_model = cfg.ai_coach_model
        self.transcriber_instance = cfg.transcriber_instance
        self.transcription_available = cfg.transcription_available
        self.slide_diff_threshold = cfg.slide_diff_threshold
        self.eval_interval = cfg.eval_interval
        self.presentation_description = cfg.presentation_description

        # Session state
        self.transcription_buffer: str = ""
        self.conversation_history: list[dict] = []
        self.log_history: list[dict] = []
        self.audio_mime_type: str = "audio/webm"
        self.audio_header: Optional[bytes] = None
        self.audio_data: list[bytes] = []
        self.prev_frame_gray: Optional[np.ndarray] = None
        self.latest_frame_b64: Optional[str] = None
        self.latest_slide_name: Optional[str] = None
        self.last_eval_time: float = time.monotonic()
        self.last_audio_flush_time: float = time.monotonic()
        self.slide_changed: bool = False
        self.is_interrupted: bool = False
        self.is_discussion: bool = False
        self.eval_running: bool = False

        # Load prompts
        self.system_prompt = self._load_prompt(
            config.PROMPT_PATH / "prompt_mid_pre.txt",
            "You are a presentation coach. If no issues are found respond with exactly: PASS",
        )

        self.qa_system_prompt = self._load_prompt(
            config.PROMPT_PATH / "prompt_qa.txt",
            "You are evaluating whether the presenter has adequately answered the advisor's question. "
            "If they have, respond with exactly: PASS. "
            "Otherwise, ask a sharp follow-up question (1–3 sentences).",
        )

        self.discussion_system_prompt_ls = [
            self._load_prompt(
                config.PROMPT_PATH / "prompt_discussion_beginning.txt",
                "You are a PhD advisor having a post-presentation discussion with the presenter. "
                "Ask insightful questions and provide constructive feedback.",
            ),
            self._load_prompt(
                config.PROMPT_PATH / "prompt_discussion_middle.txt",
                "You are a PhD advisor having a post-presentation discussion with the presenter. "
                "Ask insightful questions and provide constructive feedback.",
            ),
        ]

        # Replace {{PRESENTATION_DESCRIPTION}} placeholder in all prompts
        self._inject_presentation_description()

        # Session log path (only used locally)
        if config.RUN_ENVIRONMENT == "development":
            _session_ts = datetime.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
            self.session_log_path = config.CONVERSATIONS_DIR / f"conversation_{_session_ts}.json"
        else:
            self.session_log_path = None

    # ── Presentation description injection ─────────────────────────────

    def _inject_presentation_description(self) -> None:
        """Replace {{PRESENTATION_DESCRIPTION}} in all loaded prompts."""
        placeholder = "{{PRESENTATION_DESCRIPTION}}"
        if self.presentation_description:
            replacement = (
                "The presenter provided a description on what their presentation is about." 
                "NOTE: this description may be useless or overly broad, use your judgment and always rely more on the actual content of the presentation."
                "Below is the description:\n"
                + self.presentation_description
            )
        else:
            replacement = ""

        self.system_prompt = self.system_prompt.replace(placeholder, replacement)
        self.qa_system_prompt = self.qa_system_prompt.replace(placeholder, replacement)
        self.discussion_system_prompt_ls = [
            p.replace(placeholder, replacement) for p in self.discussion_system_prompt_ls
        ]

    # ── Prompt loading ────────────────────────────────────────────────────

    def _load_prompt(self, path: Path, fallback: str) -> str:
        if path.exists():
            return path.read_text(encoding="utf-8").strip()
        print(f"[WARN] {path} not found — using fallback prompt")
        return fallback

    # ── Transcription ─────────────────────────────────────────────────────

    async def _transcribe(self, audio_payload: bytes, prompt_text: str, mime_type: str) -> str:
        if not self.transcription_available or self.transcriber_instance is None:
            return ""

        try:
            return await self.transcriber_instance.transcribe(audio_payload, prompt_text, mime_type)
        except Exception as exc:
            print(f"[Transcription] {self.transcriber_instance.name} failed: {exc}")
            self.transcription_available = False
            try:
                await self.ws.send_text(json.dumps({"type": "transcription_unavailable"}))
            except Exception:
                pass
            return ""

    # ── LLM call ──────────────────────────────────────────────────────────

    async def _talk2AI(self, messages: list[dict], max_tokens: int = 256) -> str:
        return await llm_utils.coach_talk(
            self.llm_client, self.llm_provider, messages,
            which_model=self.ai_coach_model, max_tokens=max_tokens,
        )

    # ── Slide persistence ─────────────────────────────────────────────────

    def _save_slide(self, frame_b64: str) -> Optional[str]:
        if config.RUN_ENVIRONMENT != "development":
            return None
        try:
            img_bytes = base64.b64decode(frame_b64)
            img_array = np.frombuffer(img_bytes, dtype=np.uint8)
            frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            if frame is None:
                return None

            existing = sorted(config.SLIDES_DIR.glob("*.jpg"), key=lambda p: p.stat().st_mtime)
            while len(existing) >= config.MAX_SLIDES:
                existing.pop(0).unlink()

            ts = datetime.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
            slide_path = config.SLIDES_DIR / f"slide_{ts}.jpg"
            cv2.imwrite(str(slide_path), frame)
            print(f"[Slides] saved {slide_path.name} ({len(existing) + 1}/{config.MAX_SLIDES})")
            return slide_path.name

        except Exception as exc:
            print(f"[Slides] save error: {exc}")
            return None

    # ── Log writing ───────────────────────────────────────────────────────

    def _log_writing(self) -> None:
        if config.RUN_ENVIRONMENT != "development":
            return
        try:
            self.session_log_path.write_text(
                json.dumps(
                    llm_utils._strip_old_images(self.log_history, "image_ref"),
                    indent=2, ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except Exception as log_exc:
            print(f"[Log] write error: {log_exc}")

    # ── Slide-change detection ────────────────────────────────────────────

    def _detect_slide_change(self, frame_b64: str) -> bool:
        try:
            img_bytes = base64.b64decode(frame_b64)
            img_array = np.frombuffer(img_bytes, dtype=np.uint8)
            frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            if frame is None:
                return False
        except Exception as exc:
            print(f"[CV2] frame decode error: {exc}")
            return False

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, config.BLUR_KERNEL, 0)

        if self.prev_frame_gray is None:
            self.prev_frame_gray = blurred
            return True  # first frame always needs to be sent

        if self.prev_frame_gray.shape != blurred.shape:
            print(
                f"[CV2] frame resolution changed "
                f"{self.prev_frame_gray.shape} → {blurred.shape}; resetting reference"
            )
            self.prev_frame_gray = blurred
            return True

        diff = cv2.absdiff(self.prev_frame_gray, blurred)
        mean_diff: float = float(diff.mean())
        self.prev_frame_gray = blurred

        changed = mean_diff > self.slide_diff_threshold
        if changed:
            print(f"[CV2] slide change detected (mean diff = {mean_diff:.2f})")
        return changed

    # ── Frame scaling ─────────────────────────────────────────────────────

    def _scale_frame_b64(self, frame_b64: str, max_edge: int = 1920) -> str:
        try:
            img_bytes = base64.b64decode(frame_b64)
            img_array = np.frombuffer(img_bytes, dtype=np.uint8)
            frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            if frame is None:
                return frame_b64

            h, w = frame.shape[:2]
            if max(h, w) <= max_edge:
                return frame_b64

            scale = max_edge / max(h, w)
            new_w, new_h = int(w * scale), int(h * scale)
            resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)

            success, buf = cv2.imencode(
                ".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85]
            )
            if not success:
                return frame_b64

            print(f"[CV2] frame scaled {w}×{h} → {new_w}×{new_h}")
            return base64.b64encode(buf).decode("utf-8")

        except Exception as exc:
            print(f"[CV2] frame scaling error: {exc}")
            return frame_b64

    # ── Audio flush ───────────────────────────────────────────────────────

    async def _flush_audio(self) -> None:
        self.last_audio_flush_time = time.monotonic()

        if not self.audio_data or self.audio_header is None:
            return

        if self.audio_mime_type == "audio/wav":
            payload = transcriber_mod.merge_wav_chunks(self.audio_data)
        else:
            payload = self.audio_header + b"".join(self.audio_data)
        self.audio_data = []

        new_text = await self._transcribe(
            payload,
            transcriber_mod.TRANSCRIBER_TEXT_PROMPT,
            self.audio_mime_type,
        )

        if new_text:
            self.transcription_buffer = (self.transcription_buffer + " " + new_text).strip()
            print(f"[Transcription-Mid-Pre] transcribed: {new_text!r}")
            try:
                await self.ws.send_text(json.dumps({
                    "type": "transcript", "text": new_text, "is_final": False
                }))
            except Exception:
                pass

    # ── LLM evaluation ────────────────────────────────────────────────────

    async def _run_evaluation(self) -> None:
        if self.is_discussion or self.is_interrupted:
            print("[LLM] eval result discarded — state changed while awaiting gpt-4o")
            return

        self.last_eval_time = time.monotonic()
        self.slide_changed = False
        self.eval_running = True

        user_content: list[dict] = []
        log_content: list[dict] = []

        if self.transcription_buffer:
            prefixed_text = "[PRESENTATION TRANSCRIPT]: " + self.transcription_buffer
            text_part = {"type": "text", "text": prefixed_text}
            user_content.append(text_part)
            log_content.append(text_part)

        if self.latest_frame_b64:
            user_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{self.latest_frame_b64}",
                    "detail": "high",
                },
            })
            log_content.append({
                "type": "image_ref",
                "filename": f"_tmp/slides/{self.latest_slide_name}" if self.latest_slide_name else "(no slide saved yet)",
            })

        if not user_content:
            return

        self.conversation_history.append({"role": "user", "content": user_content})
        self.log_history.append({"role": "user", "content": log_content})
        self.transcription_buffer = ""

        try:
            await self.ws.send_text(json.dumps({
                "type": "transcript", "text": "", "is_final": True
            }))
        except Exception:
            pass

        messages = [{"role": "system", "content": self.system_prompt}] + llm_utils._strip_old_images(self.conversation_history, "image_url")

        print(f"[LLM] evaluating ({len(self.conversation_history)} turns in history) …")

        try:
            if self.fake_session:
                if random.random() < 1:
                    reply = random.choice(config.MOCK_INTERRUPTION_MESSAGES)
                else:
                    reply = "PASS"
                print(f"[LLM/FAKE] reply: {reply!r}")
            else:
                _llm_start = time.monotonic()
                reply = await self._talk2AI(messages, max_tokens=256)
                print(f"[LLM RESPONSE TIME] {time.monotonic() - _llm_start:.2f}s")
                print(f"[LLM] reply: {reply!r}")

            if reply.upper() != "PASS":
                self.is_interrupted = True

            self.conversation_history.append({"role": "assistant", "content": reply})
            self.log_history.append({"role": "assistant", "content": reply})

            self._log_writing()

            if self.is_interrupted:
                await self.ws.send_text(
                    json.dumps({"type": "interrupt", "message": reply})
                )

        except WebSocketDisconnect:
            raise
        except Exception as exc:
            print(f"[LLM] evaluation error: {exc}")
            try:
                await self.ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
            except Exception:
                pass
        finally:
            self.eval_running = False

    # ── Q&A evaluation ────────────────────────────────────────────────────

    async def _run_qa_evaluation(self, user_message: str) -> None:
        prefixed_message = "[PRESENTER Q&A REPLY]: " + user_message
        self.conversation_history.append({"role": "user", "content": prefixed_message})
        self.log_history.append({"role": "user", "content": prefixed_message})

        messages = [{"role": "system", "content": self.qa_system_prompt}] + llm_utils._strip_old_images(self.conversation_history, "image_url")

        print(f"[LLM/QA] evaluating reply ({len(self.conversation_history)} turns) …")

        try:
            if self.fake_session:
                reply = "PASS"
                print(f"[LLM/QA/FAKE] reply: {reply!r}")
            else:
                reply = await self._talk2AI(messages, max_tokens=512)
                print(f"[LLM/QA] reply: {reply!r}")

            if reply == "PASS":
                self.is_interrupted = False
                self.last_audio_flush_time = time.monotonic()
                self.last_eval_time = time.monotonic()
                self.conversation_history.append({"role": "assistant", "content": reply})
                self.log_history.append({"role": "assistant", "content": reply})
                await self.ws.send_text(json.dumps({"type": "qa_result", "status": "pass"}))
            else:
                self.conversation_history.append({"role": "assistant", "content": reply})
                self.log_history.append({"role": "assistant", "content": reply})
                await self.ws.send_text(
                    json.dumps({"type": "qa_result", "status": "follow_up", "message": reply})
                )

            self._log_writing()

        except WebSocketDisconnect:
            raise
        except Exception as exc:
            print(f"[LLM/QA] evaluation error: {exc}")
            try:
                await self.ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
            except Exception:
                pass

    # ── Discussion evaluation ─────────────────────────────────────────────

    async def _run_discussion_evaluation(self, user_message: str, phase: str) -> None:
        if phase == "BEGINNING":
            active_discussion_prompt = self.discussion_system_prompt_ls[0]
            max_tokens = 800
        else:
            active_discussion_prompt = self.discussion_system_prompt_ls[1]
            max_tokens = 512
            prefixed_message = "[PRESENTER END-OF-PRESENTATION DISCUSSION REPLY]: " + user_message
            self.conversation_history.append({"role": "user", "content": prefixed_message})
            self.log_history.append({"role": "user", "content": prefixed_message})

        messages = (
            [{"role": "system", "content": active_discussion_prompt}]
            + llm_utils._strip_all_images(self.conversation_history, "image_url")
        )

        print(f"[LLM/Discussion] evaluating reply ({len(self.conversation_history)} turns) …")

        try:
            if self.fake_session:
                if phase == "BEGINNING":
                    reply = config.MOCK_DISCUSSION_MESSAGE
                else:
                    reply = "PASS"
                print(f"[LLM/Discussion/FAKE] reply: {reply!r}")
            else:
                if phase == "BEGINNING":
                    reply = "PASS"
                    while reply == "PASS":
                        reply = await self._talk2AI(messages, max_tokens=max_tokens)
                        if reply == "PASS":
                            await asyncio.sleep(0.5)
                else:
                    reply = await self._talk2AI(messages, max_tokens=max_tokens)
                print(f"[LLM/Discussion] reply: {reply!r}")

            self.conversation_history.append({"role": "assistant", "content": reply})
            self.log_history.append({"role": "assistant", "content": reply})

            self._log_writing()

            if reply == "PASS":
                print("[LLM/Discussion] model issued PASS — discussion closed")
                await self.ws.send_text(json.dumps({"type": "discussion_closed"}))
            else:
                await self.ws.send_text(json.dumps({"type": "discussion_reply", "message": reply}))

        except WebSocketDisconnect:
            raise
        except Exception as exc:
            print(f"[LLM/Discussion] evaluation error: {exc}")
            try:
                await self.ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
            except Exception:
                pass

    # ── Main receive loop ─────────────────────────────────────────────────

    async def run(self) -> None:
        try:
            while True:
                message = await self.ws.receive()
                now = time.monotonic()

                raw_bytes: Optional[bytes] = message.get("bytes")
                raw_text: Optional[str] = message.get("text")

                if raw_bytes:
                    if self.audio_header is None:
                        self.audio_header = raw_bytes
                        print("[WS] received binary WebM audio header")
                    else:
                        self.audio_data.append(raw_bytes)

                elif raw_text:
                    try:
                        data: dict = json.loads(raw_text)
                    except json.JSONDecodeError:
                        print(f"[WS] non-JSON text received, ignoring: {raw_text[:80]}")
                        continue

                    msg_type: str = data.get("type", "")

                    if msg_type == "audio_config":
                        reported_mime: str = data.get("mimeType", "")
                        print(f"[WS] audio config received, MIME type: {reported_mime!r}")
                        if reported_mime:
                            self.audio_mime_type = reported_mime
                            print(f"[WS] audio MIME type set to {self.audio_mime_type!r}")

                    elif msg_type == "audio":
                        if not self.is_interrupted:
                            chunk_b64: str = data.get("data", "")
                            if chunk_b64:
                                chunk_bytes = base64.b64decode(chunk_b64)
                                if self.audio_mime_type == "audio/wav":
                                    self.audio_header = ""  # placeholder, not used in WAV mode
                                    self.audio_data.append(chunk_bytes)
                                else:
                                    if self.audio_header is None:
                                        self.audio_header = chunk_bytes
                                        print("[WS] received WebM audio header (via JSON)")
                                    else:
                                        self.audio_data.append(chunk_bytes)
                                # Flush immediately — each VAD segment is a complete utterance
                                await self._flush_audio()

                    elif msg_type == "frame":
                        if not self.is_interrupted:
                            frame_b64: str = data.get("data", "")
                            if frame_b64:
                                frame_b64 = self._scale_frame_b64(frame_b64)
                                self.latest_frame_b64 = frame_b64
                                if self._detect_slide_change(frame_b64):
                                    self.slide_changed = True
                                    _saved = self._save_slide(frame_b64)
                                    if _saved:
                                        self.latest_slide_name = _saved

                    elif msg_type == "qa_text":
                        qa_text: str = data.get("text", "").strip()
                        if qa_text:
                            print(f"[QA] text reply received: {qa_text!r}")
                            await self._run_qa_evaluation(qa_text)

                    elif msg_type == "resolve_thread":
                        if self.is_interrupted:
                            closure_note = "[PRESENTER Q&A REPLY]: Presenter chose to resolve this current thread."
                            self.conversation_history.append({"role": "user", "content": closure_note})
                            self.log_history.append({"role": "user", "content": closure_note})
                            self.is_interrupted = False
                            self.last_audio_flush_time = time.monotonic()
                            self.last_eval_time = time.monotonic()
                            print("[QA] presenter resolved thread manually — resuming evaluation loop")
                            self._log_writing()

                    elif msg_type == "qa_audio":
                        qa_audio_b64: str = data.get("data", "")
                        if qa_audio_b64:
                            print("[QA] audio reply received — transcribing …")
                            try:
                                qa_audio_bytes = base64.b64decode(qa_audio_b64)
                                qa_mime: str = data.get("mimeType", self.audio_mime_type)
                                qa_transcript = await self._transcribe(
                                    qa_audio_bytes,
                                    "This is an academic PhD presentation Q&A response.",
                                    qa_mime,
                                )

                                if qa_transcript:
                                    print(f"[Transcription-QA] transcript: {qa_transcript!r}")
                                    await self._run_qa_evaluation(qa_transcript)
                                else:
                                    print("[Transcription-QA] empty transcript, query the user again")
                                    await self.ws.send_text(
                                        json.dumps({"type": "qa_result", "status": "follow_up", "message": "Having trouble hearing you, try again?"})
                                    )

                            except Exception as exc:
                                print(f"[Transcription-QA] error: {exc}")
                                await self.ws.send_text(json.dumps({"type": "error", "message": str(exc)}))

                    elif msg_type == "start_discussion":
                        self.is_discussion = True
                        self.is_interrupted = False
                        print("[WS] discussion mode started — evaluation loop suspended")
                        await self._run_discussion_evaluation("", "BEGINNING")

                    elif msg_type == "discussion_text":
                        disc_text: str = data.get("text", "").strip()
                        if disc_text:
                            print(f"[Discussion] text reply received: {disc_text!r}")
                            await self._run_discussion_evaluation(disc_text, "MIDDLE")

                    elif msg_type == "discussion_audio":
                        disc_audio_b64: str = data.get("data", "")
                        if disc_audio_b64:
                            print("[Discussion] audio reply received — transcribing …")
                            try:
                                disc_audio_bytes = base64.b64decode(disc_audio_b64)
                                disc_mime: str = data.get("mimeType", self.audio_mime_type)
                                disc_transcript = await self._transcribe(
                                    disc_audio_bytes,
                                    "This is an academic PhD post-presentation discussion.",
                                    disc_mime,
                                )

                                if disc_transcript:
                                    print(f"[Transcription-Discussion] transcript: {disc_transcript!r}")
                                    await self._run_discussion_evaluation(disc_transcript, "MIDDLE")
                                else:
                                    print("[Transcription-Discussion] empty transcript, query the user again")
                                    await self.ws.send_text(
                                        json.dumps({"type": "discussion_reply", "status": "follow_up", "message": "Having trouble hearing you, try again?"})
                                    )
                            except Exception as exc:
                                print(f"[Transcription-Discussion] error: {exc}")
                                try:
                                    await self.ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
                                except Exception:
                                    pass

                # ── Periodic audio flush (presentation only) ──
                if not self.is_interrupted and not self.is_discussion and now - self.last_audio_flush_time >= config.AUDIO_FLUSH_INTERVAL_SECONDS:
                    await self._flush_audio()

                # ── Agent evaluation trigger ──
                time_elapsed = ((now - self.last_eval_time) >= self.eval_interval) and (len(self.transcription_buffer) >= 200 or self.fake_session)
                buffer_long = len(self.transcription_buffer) >= 500
                slide_ready = self.slide_changed and len(self.transcription_buffer) >= 150
                if not self.is_interrupted and not self.is_discussion and not self.eval_running and (slide_ready or time_elapsed or buffer_long):
                    print(f"[LLM eval triggered]: bugger long: {len(self.transcription_buffer)}, slide_changed: {self.slide_changed}, time_elapsed: {time_elapsed}")
                    await self._flush_audio()
                    await self._run_evaluation()

        except WebSocketDisconnect:
            print("[WS] client disconnected cleanly")
        except RuntimeError as exc:
            if "disconnect" in str(exc).lower() or "close message" in str(exc).lower():
                print("[WS] client disconnected (connection closed by client)")
            else:
                print(f"[WS] unexpected runtime error: {exc}")
                raise
        except Exception as exc:
            print(f"[WS] unexpected error: {exc}")
            raise
