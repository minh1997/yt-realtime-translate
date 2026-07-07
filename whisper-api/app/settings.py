# settings.py — environment-driven configuration for the local Whisper API.
#
# Every value can be overridden via an environment variable (e.g. in a local
# .env file, loaded by python-dotenv) without touching code:
#   STT_MODEL=medium uvicorn app.main:app --host 127.0.0.1 --port 8787

import os

from dotenv import load_dotenv

load_dotenv()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Recommended models (see whisper-api/README.md for tradeoffs):
#   base          — faster, lower quality
#   small         — good starting point (default)
#   medium        — better quality, slower
#   large-v3-turbo — better quality if the machine is strong
STT_MODEL = os.getenv("STT_MODEL", "small")
STT_DEVICE = os.getenv("STT_DEVICE", "cpu")
STT_COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "ja")
STT_SAMPLE_RATE = int(os.getenv("STT_SAMPLE_RATE", "16000"))

# Streaming/windowing (see app/session.py):
#   Every STT_STRIDE_SECONDS, the latest STT_WINDOW_SECONDS (+ overlap) of
#   audio is (re-)transcribed. The window is deliberately much longer than
#   the stride so that a transcription cycle that takes a while (or gets
#   skipped because the previous one is still running) still overlaps the
#   next one — this is what prevents gaps/missed speech during fast,
#   continuous talking.
STT_WINDOW_SECONDS = float(os.getenv("STT_WINDOW_SECONDS", "8.0"))
STT_STRIDE_SECONDS = float(os.getenv("STT_STRIDE_SECONDS", "2.0"))
STT_OVERLAP_SECONDS = float(os.getenv("STT_OVERLAP_SECONDS", "2.0"))
STT_MAX_BUFFER_SECONDS = float(os.getenv("STT_MAX_BUFFER_SECONDS", "60.0"))

# faster-whisper transcription parameters, tuned for low latency + fewer
# missed segments on fast continuous speech (see app/transcriber.py).
STT_BEAM_SIZE = int(os.getenv("STT_BEAM_SIZE", "1"))
STT_VAD_FILTER = _env_bool("STT_VAD_FILTER", False)
STT_CONDITION_ON_PREVIOUS_TEXT = _env_bool("STT_CONDITION_ON_PREVIOUS_TEXT", True)

# Even without silence, accumulated/stable transcript text is flushed to the
# client as a "final" ASR_TEXT at least this often, so a speaker who never
# pauses still produces periodic final lines (and LLM translations).
STT_FINALIZE_INTERVAL_SECONDS = float(os.getenv("STT_FINALIZE_INTERVAL_SECONDS", "8.0"))
