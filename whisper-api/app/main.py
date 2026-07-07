# main.py — local Whisper ASR API.
#
# GET /health         -> {"status": "ok", "engine": "faster-whisper"}
# WebSocket /asr       -> near-realtime transcription of streamed PCM audio.
#
# WebSocket protocol (see extension/src/offscreen/stt-client.js for the
# client side):
#   1. Client connects, then sends one JSON config message:
#        {"type": "config", "sampleRate": 16000, "encoding": "pcm_s16le",
#         "channels": 1, "language": "ja", "task": "transcribe"}
#   2. Client streams binary Int16 PCM frames (little-endian, mono).
#   3. Server sends JSON messages back at any time:
#        {"type": "ASR_STATUS", "text": "...", "rms": 0.034, "bufferSeconds": 18.4}
#        {"type": "ASR_TEXT", "text": "...", "isFinal": false, "engine": "faster-whisper",
#         "windowStartMs": 12000, "windowEndMs": 20000, "sequence": 12}
#        {"type": "ASR_TEXT", "text": "...", "isFinal": true,  "engine": "faster-whisper", "sequence": 13}
#        {"type": "ASR_ERROR", "text": "..."}
#   Extra fields on ASR_STATUS/ASR_TEXT are additive — the extension ignores
#   anything it doesn't recognize.
#
# The actual streaming/buffering/transcription logic lives in session.py
# (ASRSession): a non-blocking audio receiver runs concurrently with a
# background transcription worker over overlapping windows, so a slow or
# busy faster-whisper call never blocks audio from being received, and nothing
# is dropped even if the speaker never pauses. See session.py's module
# docstring for the full design rationale.

import asyncio

from fastapi import FastAPI, WebSocket

from .session import ASRSession
from .transcriber import get_transcriber

app = FastAPI(title="Local Whisper ASR API")


@app.on_event("startup")
async def _preload_model() -> None:
    # Load the faster-whisper model once at startup (in a worker thread, so it
    # doesn't block the event loop) rather than on the first WebSocket
    # message, so the first real utterance of a session isn't stuck behind a
    # multi-second model load.
    await asyncio.to_thread(get_transcriber)


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "faster-whisper"}


@app.websocket("/asr")
async def asr_ws(websocket: WebSocket):
    await websocket.accept()

    try:
        config = await websocket.receive_json()
    except Exception:
        await websocket.close()
        return

    session = ASRSession(websocket, config)

    # receive_audio_loop and transcribe_loop run concurrently: the receiver
    # must never block on transcription, so audio keeps flowing into the
    # rolling buffer even while faster-whisper is busy with a previous
    # window. Whichever task ends first (normally the receiver, on
    # disconnect) triggers cleanup of the other.
    receiver_task = asyncio.create_task(session.receive_audio_loop())
    transcriber_task = asyncio.create_task(session.transcribe_loop())

    try:
        await asyncio.wait(
            {receiver_task, transcriber_task}, return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        session.running = False
        for task in (receiver_task, transcriber_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(receiver_task, transcriber_task, return_exceptions=True)
        await session.finalize_remaining()

