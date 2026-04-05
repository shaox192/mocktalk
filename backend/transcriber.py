import asyncio
import io
from abc import ABC, abstractmethod

from openai import AsyncOpenAI

## we don't want this on render. But force them to have it locally maybe?
try:
    from faster_whisper import WhisperModel
    _WHISPER_IMPORT_OK = True
except ImportError:
    _WHISPER_IMPORT_OK = False

TRANSCRIBER_TEXT_PROMPT: str = (
    "This is an academic PhD presentation. "
    "The speaker is discussing scientific research and methodology."
)


def _load_whisper_model():
    try:
        print("[WHISPER] Attempting to load whisper on GPU...")
        return WhisperModel("small.en", device="cuda", compute_type="float16")
    except Exception as e:
        print(f"[WHISPER] GPU not available, falling back to CPU. (Reason: {e})")
        return WhisperModel("small.en", device="cpu", compute_type="int8")


class Transcriber(ABC):
    """
    Common interface for all transcription backends.
    """

    def _mime_to_ext(self, mime_type: str) -> str:
        """Map a MediaRecorder MIME type to the file extension FFmpeg expects."""
        if "mp4" in mime_type:
            return ".mp4"
        if "ogg" in mime_type:
            return ".ogg"
        return ".webm"

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    async def transcribe(self, audio_payload: bytes, prompt_text: str, mime_type: str) -> str: ...


class OpenAITranscriber(Transcriber):
    def __init__(self, client: AsyncOpenAI, model: str = "whisper-1"):
        self._client = client
        self._model = model

    @property
    def name(self) -> str:
        return "openai"

    async def transcribe(self, audio_payload: bytes, prompt_text: str, mime_type: str) -> str:
        ext = self._mime_to_ext(mime_type)
        result = await self._client.audio.transcriptions.create(
            file=(f"audio{ext}", audio_payload),
            model=self._model,
            language="en",
            prompt=prompt_text,
        )
        return result.text.strip()


class GroqTranscriber(Transcriber):
    def __init__(self, client: AsyncOpenAI, model: str = "whisper-large-v3-turbo"):
        self._client = client
        self._model = model

    @property
    def name(self) -> str:
        return "groq"

    async def transcribe(self, audio_payload: bytes, prompt_text: str, mime_type: str) -> str:
        ext = self._mime_to_ext(mime_type)
        result = await self._client.audio.transcriptions.create(
            file=(f"audio{ext}", audio_payload),
            model=self._model,
            language="en",
            prompt=prompt_text,
        )
        return result.text.strip()


class LocalTranscriber(Transcriber):
    """
    Wraps the local faster_whisper model. Loads the model lazily on first use.
    """

    def __init__(self, model=None):
        self._model = model

    @property
    def name(self) -> str:
        return "local"

    def _ensure_model(self):
        if self._model is None:
            print("[WHISPER] Loading model on first use (deferred)...")
            self._model = _load_whisper_model()

    async def transcribe(self, audio_payload: bytes, prompt_text: str, mime_type: str) -> str:
        self._ensure_model()
        ext = self._mime_to_ext(mime_type)
        audio_buffer = io.BytesIO(audio_payload)
        audio_buffer.name = f"audio{ext}"
        text = await asyncio.to_thread(self._run_whisper, audio_buffer, prompt_text)
        return text.strip()

    def _run_whisper(self, audio_buffer, prompt_text: str) -> str:
        segments, _info = self._model.transcribe(
            audio_buffer,
            beam_size=5,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt=prompt_text,
        )
        return " ".join(segment.text for segment in segments)


def merge_wav_chunks(chunks: list[bytes]) -> bytes:
    """
    Merge multiple self-contained WAV files into one.
    Assumes all chunks share the same sample rate, channels, bit depth.
    """
    if not chunks:
        return b""
    if len(chunks) == 1:
        return chunks[0]

    # Strip 44-byte header from each, keep only PCM data
    raw_pcm = b"".join(chunk[44:] for chunk in chunks)

    # Rebuild a single WAV header for the combined PCM
    header = bytearray(chunks[0][:44])

    # Update the two size fields in the header:
    # bytes 4-7:  total file size minus 8
    # bytes 40-43: data chunk size
    data_size = len(raw_pcm)
    file_size = data_size + 36  # 44 - 8 = 36
    header[4:8] = file_size.to_bytes(4, "little")
    header[40:44] = data_size.to_bytes(4, "little")

    return bytes(header) + raw_pcm
