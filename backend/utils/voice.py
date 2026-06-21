"""Deepgram speech-to-text and text-to-speech helpers."""
from __future__ import annotations

import os

import httpx

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
_STT_URL = "https://api.deepgram.com/v1/listen"
_TTS_URL = "https://api.deepgram.com/v1/speak"


async def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/webm") -> str:
    """Return the transcript string from raw audio bytes via Deepgram nova-2."""
    if not DEEPGRAM_API_KEY:
        raise ValueError("DEEPGRAM_API_KEY is not configured")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _STT_URL,
            params={"model": "nova-2", "smart_format": "true", "punctuate": "true"},
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
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
    if not DEEPGRAM_API_KEY:
        raise ValueError("DEEPGRAM_API_KEY is not configured")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _TTS_URL,
            params={"model": voice},
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"text": text},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.content
