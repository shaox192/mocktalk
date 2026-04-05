import base64
import re

from openai import AsyncOpenAI
from anthropic import AsyncAnthropic
from google import genai
from google.genai import types as genai_types


# ── openai / openai-compatible (also used for Groq, gemini???) ────────────────────────

async def talk2AI(
    client: AsyncOpenAI,
    messages: list[dict],
    which_model: str = "gpt-4o",
    max_tokens: int = 256,
) -> str:
    response = await client.chat.completions.create(
        model=which_model,
        messages=messages,
        max_tokens=max_tokens,
    )
    reply = response.choices[0].message.content.strip()
    if reply.startswith('"') and reply.endswith('"'):
        reply = reply[1:-1]
    return reply


# ── Anthropic ───────────────────────────────────────────────────────────────

def _openai_to_anthropic_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    """
    Convert OpenAI-format messages to Anthropic format.
    Returns (system_prompt, anthropic_messages).
    """
    system_parts: list[str] = []
    anthropic_msgs: list[dict] = []

    for msg in messages:
        role = msg["role"]
        content = msg.get("content")

        if role == "system":
            system_parts.append(content if isinstance(content, str) else "")
            continue

        if isinstance(content, str):
            anthropic_msgs.append({"role": role, "content": content})
            continue

        # content is a list of parts — convert image_url → anthropic image block
        converted_parts: list[dict] = []
        for part in content:
            if part.get("type") == "text":
                converted_parts.append({"type": "text", "text": part["text"]})
            elif part.get("type") == "image_url":
                url: str = part["image_url"]["url"]
                # Extract base64 data and media type from data URI
                match = re.match(r"data:(image/\w+);base64,(.+)", url, re.DOTALL)
                if match:
                    media_type, b64_data = match.group(1), match.group(2)
                    converted_parts.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64_data,
                        },
                    })
        if converted_parts:
            anthropic_msgs.append({"role": role, "content": converted_parts})

    return "\n\n".join(system_parts), anthropic_msgs


async def talk2AI_anthropic(
    client: AsyncAnthropic,
    messages: list[dict],
    which_model: str,
    max_tokens: int = 256,
) -> str:
    system_prompt, anthropic_messages = _openai_to_anthropic_messages(messages)
    response = await client.messages.create(
        model=which_model,
        system=system_prompt,
        messages=anthropic_messages,
        max_tokens=max_tokens,
    )
    reply = response.content[0].text.strip()
    if reply.startswith('"') and reply.endswith('"'):
        reply = reply[1:-1]
    return reply


# ── Google Gemini ───────────────────────────────────────────────────────────

def _openai_to_gemini_contents(messages: list[dict]) -> tuple[str, list[genai_types.Content]]:
    """
    Convert OpenAI-format messages to google-genai Content objects.
    Returns (system_instruction, contents_list).
    """
    system_parts: list[str] = []
    contents: list[genai_types.Content] = []

    for msg in messages:
        role = msg["role"]
        content = msg.get("content")

        if role == "system":
            system_parts.append(content if isinstance(content, str) else "")
            continue

        gemini_role = "model" if role == "assistant" else "user"

        if isinstance(content, str):
            contents.append(genai_types.Content(
                role=gemini_role,
                parts=[genai_types.Part.from_text(text=content)],
            ))
            continue

        # This is a list of parts
        parts: list[genai_types.Part] = []
        for part in content:
            if part.get("type") == "text":
                parts.append(genai_types.Part.from_text(text=part["text"]))
            elif part.get("type") == "image_url":
                url: str = part["image_url"]["url"]
                match = re.match(r"data:(image/\w+);base64,(.+)", url, re.DOTALL)
                if match:
                    media_type, b64_data = match.group(1), match.group(2)
                    parts.append(genai_types.Part.from_bytes(
                        data=base64.b64decode(b64_data),
                        mime_type=media_type,
                    ))
        if parts:
            contents.append(genai_types.Content(role=gemini_role, parts=parts))

    return "\n\n".join(system_parts), contents


async def talk2AI_google(
    client: genai.Client,
    messages: list[dict],
    which_model: str,
    max_tokens: int = 256,
) -> str:
    system_instruction, contents = _openai_to_gemini_contents(messages)
    response = await client.aio.models.generate_content(
        model=which_model,
        contents=contents,
        config=genai_types.GenerateContentConfig(
            system_instruction=system_instruction if system_instruction else None,
            max_output_tokens=max_tokens,
        ),
    )
    reply = response.text.strip()
    if reply.startswith('"') and reply.endswith('"'):
        reply = reply[1:-1]
    return reply


# ── Dispatcher ──────────────────────────────────────────────────────────────

async def coach_talk(
    client: object,
    provider: str,
    messages: list[dict],
    which_model: str,
    max_tokens: int = 256,
) -> str:
    """Route to the correct provider-specific LLM call."""
    if provider == "anthropic":
        return await talk2AI_anthropic(client, messages, which_model, max_tokens)
    elif provider == "google":
        return await talk2AI_google(client, messages, which_model, max_tokens)
    else:
        # openai (and any oai-compatible provider)
        return await talk2AI(client, messages, which_model, max_tokens)


def _strip_old_images(history: list[dict], image_type: str) -> list[dict]:
    """
    Return a copy of history where every list-content turn that contains an
    entry of `image_type` has that entry removed, EXCEPT for the last such turn.
    Turns whose content becomes empty after stripping are omitted entirely.
    """
    last_image_idx = max(
        (i for i, msg in enumerate(history)
         if isinstance(msg.get("content"), list)
         and any(p.get("type") == image_type for p in msg["content"])),
        default=-1,
    )
    cleaned: list[dict] = []
    for i, msg in enumerate(history):
        content = msg.get("content")
        if isinstance(content, list) and i != last_image_idx:
            content = [p for p in content if p.get("type") != image_type]
            if not content:
                continue
            msg = {**msg, "content": content}
        cleaned.append(msg)
    return cleaned


def _strip_all_images(history: list[dict], image_type: str) -> list[dict]:
    """
    Return a copy of history with ALL entries of `image_type` removed from
    every turn. Turns whose content becomes empty after stripping are omitted.
    """
    cleaned: list[dict] = []
    for msg in history:
        content = msg.get("content")
        if isinstance(content, list):
            content = [p for p in content if p.get("type") != image_type]
            if not content:
                continue
            msg = {**msg, "content": content}
        cleaned.append(msg)
    return cleaned
