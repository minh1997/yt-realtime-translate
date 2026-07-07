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
| `STT_WINDOW_SECONDS` | `8.0` | Every `STT_STRIDE_SECONDS`, the latest `STT_WINDOW_SECONDS` (+ overlap) of audio is (re-)transcribed |
| `STT_STRIDE_SECONDS` | `2.0` | How often a transcription cycle starts |
| `STT_OVERLAP_SECONDS` | `2.0` | Extra look-back added on top of `STT_WINDOW_SECONDS`, purely to give word/sentence merging a wider chance to find the overlap between consecutive windows |
| `STT_MAX_BUFFER_SECONDS` | `60.0` | Max audio kept in the rolling buffer per connection |
| `STT_BEAM_SIZE` | `1` | faster-whisper beam size (`1` = greedy, fastest) |
| `STT_VAD_FILTER` | `false` | Whisper's built-in VAD filter. Off by default — it can strip speech during fast, continuous audio with little silence between words |
| `STT_CONDITION_ON_PREVIOUS_TEXT` | `true` | Helps the model stay consistent across overlapping windows |
| `STT_FINALIZE_INTERVAL_SECONDS` | `8.0` | Even without silence, accumulated text is flushed as a "final" `ASR_TEXT` at least this often, so a speaker who never pauses still gets periodic final lines (and LLM translations) |

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
   { "type": "ASR_STATUS", "text": "Receiving audio... RMS=0.034", "rms": 0.034, "bufferSeconds": 18.4 }
   { "type": "ASR_TEXT", "text": "...", "isFinal": false, "engine": "faster-whisper", "windowStartMs": 12000, "windowEndMs": 20000, "sequence": 12 }
   { "type": "ASR_TEXT", "text": "...", "isFinal": true,  "engine": "faster-whisper", "sequence": 13 }
   { "type": "ASR_ERROR", "text": "..." }
   ```
   Extra fields are additive — the extension ignores anything it doesn't
   recognize.

### Streaming design (audio receiving vs. transcription)

Whisper is chunk-based, not true streaming ASR. Each WebSocket connection
runs two concurrent tasks (see `app/session.py`):

- **Receiver** — never blocks on transcription; it just appends incoming PCM
  to a thread-safe rolling buffer (`app/audio_buffer.py`) and reports
  RMS/silence status. This keeps receiving audio continuously even while a
  transcription is in progress, so fast/continuous speech never gets stuck
  behind a busy model.
- **Transcriber** — every `STT_STRIDE_SECONDS`, transcribes the *latest*
  `STT_WINDOW_SECONDS` (+ overlap) of buffered audio in a worker thread
  (`asyncio.to_thread`). Because the window is much longer than the stride,
  windows overlap substantially, so a slow or skipped cycle still gets
  picked up by the next window instead of leaving a gap. If a transcription
  is still running when the next cycle would start, that cycle is skipped —
  audio is never discarded, it just gets transcribed a little later as part
  of a longer window.

Since windows overlap, each transcription re-covers some already-seen
audio. `app/transcript_merge.py` finds the longest suffix/prefix overlap
between the running accumulated transcript and the new window's raw text
and appends only the new part, so the transcript grows smoothly instead of
being replaced every cycle (which used to make earlier speech disappear
once it scrolled out of a single "latest N seconds" window).

Finalization (turning growing text into a completed, translatable line) is
triggered by whichever comes first: ~0.8s of silence, or
`STT_FINALIZE_INTERVAL_SECONDS` of continuous speech with no pause — so a
speaker who never stops talking still produces periodic final lines instead
of one partial that grows forever and is never translated.

If a transcription cycle takes longer than the audio it covers (realtime
factor > 1.0), the server sends an `ASR_STATUS` warning suggesting a smaller
model or a longer stride; see `app/session.py`'s per-cycle log line for the
exact timings.
