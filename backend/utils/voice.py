"""Deepgram speech-to-text and text-to-speech helpers."""
from __future__ import annotations

import os

import httpx

_STT_URL = "https://api.deepgram.com/v1/listen"
_TTS_URL = "https://api.deepgram.com/v1/speak"


def _api_key() -> str:
    """Read the key at call-time so it picks up .env reloads without restart."""
    key = os.getenv("DEEPGRAM_API_KEY", "")
    if not key:
        raise ValueError("DEEPGRAM_API_KEY is not configured")
    return key


async def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/webm") -> str:
    """Return the transcript string from raw audio bytes via Deepgram nova-2."""
    key = _api_key()

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _STT_URL,
            params={"model": "nova-2", "smart_format": "true", "punctuate": "true"},
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": mimetype,
            },
            content=audio_bytes,
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

    try:
        return data["results"]["channels"][0]["alternatives"][0]["transcript"]
    except (KeyError, IndexError):
        return ""


async def speak_text(text: str, voice: str = "aura-asteria-en") -> bytes:
    """Return MP3 audio bytes for *text* via Deepgram Aura TTS."""
    key = _api_key()

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _TTS_URL,
            params={"model": voice},
            headers={
                "Authorization": f"Token {key}",
                "Content-Type": "application/json",
            },
            json={"text": text},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.content
