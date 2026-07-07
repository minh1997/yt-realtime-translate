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
#        {"type": "ASR_STATUS", "text": "Receiving audio... RMS=0.034"}
#        {"type": "ASR_TEXT", "text": "...", "isFinal": false, "engine": "faster-whisper"}
#        {"type": "ASR_TEXT", "text": "...", "isFinal": true,  "engine": "faster-whisper"}
#        {"type": "ASR_ERROR", "text": "..."}
#
# Whisper is chunk-based, not true streaming ASR. Every STT_CHUNK_SECONDS we
# transcribe the latest rolling window of audio (AudioBuffer) and emit it as
# a (deduplicated) partial ASR_TEXT. A partial is promoted to a final
# ASR_TEXT once the audio has gone quiet (RMS below SILENCE_RMS_THRESHOLD)
# for FINAL_SILENCE_SECONDS — a simple silence-based finalization strategy,
# not full VAD/endpointing.

import asyncio
import time

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .audio_buffer import AudioBuffer
from .settings import STT_CHUNK_SECONDS, STT_OVERLAP_SECONDS, STT_SAMPLE_RATE
from .transcriber import get_transcriber

app = FastAPI(title="Local Whisper ASR API")

SILENCE_RMS_THRESHOLD = 0.01
FINAL_SILENCE_SECONDS = 0.8
STATUS_REPORT_INTERVAL_SECONDS = 0.3


def normalize_text(text: str) -> str:
    # Simple trim + whitespace-collapse. Deliberately not inserting/removing
    # spaces beyond that: Japanese text from Whisper already comes back
    # without spaces between words, and adding any would be wrong.
    return " ".join(text.strip().split())


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

    language = config.get("language", "ja")
    transcriber = get_transcriber()
    buffer = AudioBuffer(sample_rate=STT_SAMPLE_RATE)

    last_partial_text = ""
    last_final_text = ""
    last_transcribe_time = 0.0
    last_status_time = 0.0
    silence_started_at = None
    transcribing = False

    async def transcribe_and_send(chunk: np.ndarray) -> None:
        nonlocal last_partial_text, transcribing
        transcribing = True
        try:
            text = await asyncio.to_thread(transcriber.transcribe_chunk, chunk, language)
            text = normalize_text(text)

            if text and text != last_partial_text:
                last_partial_text = text
                await websocket.send_json(
                    {
                        "type": "ASR_TEXT",
                        "text": text,
                        "isFinal": False,
                        "engine": "faster-whisper",
                    }
                )
        except Exception as exc:
            try:
                await websocket.send_json({"type": "ASR_ERROR", "text": str(exc)})
            except Exception:
                pass
        finally:
            transcribing = False

    try:
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            data = message.get("bytes")
            if data is None:
                # Ignore any stray non-binary frames after the initial config.
                continue

            audio_i16 = np.frombuffer(data, dtype=np.int16)
            audio_f32 = audio_i16.astype(np.float32) / 32768.0

            buffer.add_audio(audio_f32)

            rms = float(np.sqrt(np.mean(audio_f32 ** 2))) if audio_f32.size else 0.0
            now = time.time()

            if now - last_status_time >= STATUS_REPORT_INTERVAL_SECONDS:
                last_status_time = now
                await websocket.send_json(
                    {"type": "ASR_STATUS", "text": f"Receiving audio... RMS={rms:.3f}"}
                )

            # Simple silence-based finalization: once RMS has stayed below the
            # threshold for FINAL_SILENCE_SECONDS, promote the current partial
            # to a final (deduplicated so we never send the same final twice).
            if rms < SILENCE_RMS_THRESHOLD:
                if silence_started_at is None:
                    silence_started_at = now
                elif (
                    now - silence_started_at >= FINAL_SILENCE_SECONDS
                    and last_partial_text
                    and last_partial_text != last_final_text
                ):
                    last_final_text = last_partial_text
                    await websocket.send_json(
                        {
                            "type": "ASR_TEXT",
                            "text": last_final_text,
                            "isFinal": True,
                            "engine": "faster-whisper",
                        }
                    )
                    silence_started_at = None
            else:
                silence_started_at = None

            if (
                not transcribing
                and now - last_transcribe_time >= STT_CHUNK_SECONDS
                and buffer.duration_seconds() > 0
            ):
                last_transcribe_time = now
                chunk = buffer.get_latest_chunk(STT_CHUNK_SECONDS + STT_OVERLAP_SECONDS)
                if chunk.size > 0:
                    asyncio.create_task(transcribe_and_send(chunk))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({"type": "ASR_ERROR", "text": str(exc)})
        except Exception:
            pass
