"""ElevenLabs speech-to-text (Scribe) and text-to-speech helpers."""
from __future__ import annotations

import os

import httpx

_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

# Sarah — premade, available on free tier, sounds great for assistant replies.
# Override via ELEVENLABS_VOICE_ID env var.
_DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"


def _api_key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY", "")
    if not key:
        raise ValueError("ELEVENLABS_API_KEY is not set in .env")
    return key


def _voice_id() -> str:
    return os.getenv("ELEVENLABS_VOICE_ID", _DEFAULT_VOICE_ID)


async def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/webm") -> str:
    """Return transcript string from raw audio bytes via ElevenLabs Scribe STT."""
    key = _api_key()

    # Scribe expects multipart/form-data with a `file` field.
    # We pick a filename extension that matches the mimetype so ElevenLabs
    # auto-detects the codec correctly.
    ext = "webm"
    if "ogg" in mimetype:
        ext = "ogg"
    elif "mp4" in mimetype or "m4a" in mimetype:
        ext = "mp4"
    elif "wav" in mimetype:
        ext = "wav"
    elif "mp3" in mimetype or "mpeg" in mimetype:
        ext = "mp3"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            _STT_URL,
            headers={"xi-api-key": key},
            files={"file": (f"audio.{ext}", audio_bytes, mimetype)},
            data={"model_id": "scribe_v1"},
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

    # ElevenLabs Scribe returns {"text": "...", "words": [...], ...}
    return data.get("text", "").strip()


async def speak_text(text: str) -> bytes:
    """Return MP3 audio bytes for *text* via ElevenLabs TTS."""
    key = _api_key()
    voice = _voice_id()
    url = _TTS_URL.format(voice_id=voice)

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            headers={
                "xi-api-key": key,
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": "eleven_flash_v2_5",
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.75,
                    "style": 0.0,
                    "use_speaker_boost": True,
                },
            },
            timeout=30.0,
        )
        response.raise_for_status()
        return response.content
