"""Deepgram speech-to-text (nova-2) and text-to-speech (Aura) helpers."""
from __future__ import annotations

import os

import httpx

_STT_URL = "https://api.deepgram.com/v1/listen"
_TTS_URL = "https://api.deepgram.com/v1/speak"

# Aura-Asteria is Deepgram's default natural-sounding voice for assistant replies.
_DEFAULT_TTS_MODEL = "aura-asteria-en"


def status() -> dict[str, str | bool]:
    """Public, secret-free Deepgram configuration status for the extension UI."""
    return {
        "configured": bool(os.getenv("DEEPGRAM_API_KEY", "").strip()),
        "stt_model": "nova-2",
        "tts_model": os.getenv("DEEPGRAM_TTS_MODEL", _DEFAULT_TTS_MODEL),
    }


def _api_key() -> str:
    # Read lazily so the key is picked up even if .env loads after import.
    key = os.getenv("DEEPGRAM_API_KEY", "")
    if not key:
        raise ValueError("DEEPGRAM_API_KEY is not set in .env")
    return key


async def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/webm") -> str:
    """Return the transcript for raw audio bytes via Deepgram nova-2.

    Empty/near-empty blobs (mic opened but nothing said) are skipped instead of
    hitting Deepgram, and a 400 is treated as "nothing usable heard" rather than
    an error so the push-to-talk UX never surfaces a scary failure.
    """
    if len(audio_bytes) < 1000:
        return ""

    key = _api_key()

    # Deepgram auto-detects the container from Content-Type; strip codec
    # suffixes like ";codecs=opus" which can trip up nova-2.
    base_mime = mimetype.split(";")[0].strip().lower() or "audio/webm"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _STT_URL,
            params={"model": "nova-2", "smart_format": "true", "punctuate": "true"},
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": base_mime,
            },
            content=audio_bytes,
            timeout=30.0,
        )
        if response.status_code == 400:
            # Usually an empty/corrupt blob — return no transcript, not an error.
            return ""
        response.raise_for_status()
        data = response.json()

    try:
        return data["results"]["channels"][0]["alternatives"][0]["transcript"].strip()
    except (KeyError, IndexError):
        return ""


async def speak_text(text: str, voice: str | None = None) -> bytes:
    """Return MP3 audio bytes for *text* via Deepgram Aura TTS."""
    key = _api_key()
    model = voice or os.getenv("DEEPGRAM_TTS_MODEL", _DEFAULT_TTS_MODEL)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _TTS_URL,
            params={"model": model},
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": "application/json",
            },
            json={"text": text},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.content
