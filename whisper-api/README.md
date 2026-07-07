# whisper-api

A local Whisper ASR server (FastAPI + [faster-whisper](https://github.com/SYSTRAN/faster-whisper))
used by the Chrome extension in this repo instead of an in-browser WASM ASR
engine. It runs entirely on your machine — no audio ever leaves it, and no
remote STT API is called.

```
Chrome Extension (offscreen.js)
  → WebSocket ws://127.0.0.1:8787/asr
  → whisper-api (this server)
  → faster-whisper
  → transcript JSON back over the same WebSocket
```

## Setup

```bash
cd whisper-api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload
```

Or, from the repository root, `npm run dev:whisper` (or `npm run dev`, which
also starts the extension's Vite dev build) runs this same command for you.

## Environment variables

All optional — defaults are shown. Put these in a `whisper-api/.env` file if
you want to override them (loaded automatically via `python-dotenv`).

| Variable | Default | Notes |
|---|---|---|
| `STT_MODEL` | `small` | See recommended models below |
| `STT_DEVICE` | `cpu` | `cpu` or `cuda` (if you have a supported GPU + CUDA toolkit) |
| `STT_COMPUTE_TYPE` | `int8` | `int8` (fastest on CPU), `int8_float16`, `float16`, `float32` |
| `STT_LANGUAGE` | `ja` | Fallback language if a client doesn't send one in its config message |
| `STT_SAMPLE_RATE` | `16000` | Must match the PCM sample rate the extension sends (16kHz) |
| `STT_CHUNK_SECONDS` | `3.0` | How often a rolling audio window is transcribed |
| `STT_OVERLAP_SECONDS` | `0.5` | Extra look-back added to each transcribed chunk, to avoid cutting off words at the boundary |

### Recommended models

| Model | Notes |
|---|---|
| `base` | Fastest, lower transcription quality |
| `small` | Good starting point (default) |
| `medium` | Better quality, slower |
| `large-v3-turbo` | Best quality, needs a stronger machine |

## API

### `GET /health`

```json
{ "status": "ok", "engine": "faster-whisper" }
```

### `WebSocket /asr`

1. Client sends one JSON config message right after connecting:
   ```json
   {
     "type": "config",
     "sampleRate": 16000,
     "encoding": "pcm_s16le",
     "channels": 1,
     "language": "ja",
     "task": "transcribe"
   }
   ```
2. Client streams binary frames: little-endian `Int16` PCM, mono, at
   `sampleRate`.
3. Server sends JSON messages back at any time:
   ```json
   { "type": "ASR_STATUS", "text": "Receiving audio... RMS=0.034" }
   { "type": "ASR_TEXT", "text": "...", "isFinal": false, "engine": "faster-whisper" }
   { "type": "ASR_TEXT", "text": "...", "isFinal": true,  "engine": "faster-whisper" }
   { "type": "ASR_ERROR", "text": "..." }
   ```

Whisper is chunk-based, not true streaming ASR — transcription happens on a
rolling window of the last few seconds of audio (`STT_CHUNK_SECONDS`), and a
partial result is promoted to a final result once the audio has been quiet
for `FINAL_SILENCE_SECONDS` (simple RMS-based silence detection, not full
VAD/endpointing). This is intentionally simple; see `app/main.py` to improve it
further.
