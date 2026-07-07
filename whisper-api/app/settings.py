# settings.py — environment-driven configuration for the local Whisper API.
#
# Every value can be overridden via an environment variable (e.g. in a local
# .env file, loaded by python-dotenv) without touching code:
#   STT_MODEL=medium uvicorn app.main:app --host 127.0.0.1 --port 8787

import os

from dotenv import load_dotenv

load_dotenv()

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
STT_CHUNK_SECONDS = float(os.getenv("STT_CHUNK_SECONDS", "3.0"))
STT_OVERLAP_SECONDS = float(os.getenv("STT_OVERLAP_SECONDS", "0.5"))
