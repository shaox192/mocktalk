from pathlib import Path


import os
RUN_ENVIRONMENT = os.getenv("MOCKTALK_ENV", "development")

# ── Paths ─────────────────────────────────────────────────────────────────
PROMPT_PATH = Path(__file__).parent / "prompts"
TMP_DIR = Path(__file__).parent / "_tmp"
SLIDES_DIR = TMP_DIR / "slides"
CONVERSATIONS_DIR = TMP_DIR / "conversations"

# ── Slide detection ──────────────────────────────────────────────────────
BLUR_KERNEL = (15, 15)
MAX_SLIDES: int = 10

# ── Timing ───────────────────────────────────────────────────────────────
AUDIO_FLUSH_INTERVAL_SECONDS: float = 2.0

# ── Mock messages for fake sessions ──────────────────────────────────────
MOCK_INTERRUPTION_MESSAGES: list[str] = [
    "Could you enlarge the axis labels on this spatial frequency plot? It's a bit hard to read from the back.",
    "Before you move on, how does this specific adversarial defense mechanism align with the hierarchical structure of the human ventral visual stream?",
    "I'm not quite following this slide. Are you using Representational Similarity Analysis (RSA) here to compare the DCNN representations directly to the human neural data?",
]

MOCK_DISCUSSION_MESSAGE: str = (
    "I get what you are trying to convey in the talk. However, I am still a bit confused "
    "about how your proposed method compares to the current state-of-the-art methods. "
    "Could you elaborate on that a bit more?"
)
