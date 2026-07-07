# transcriber.py — faster-whisper wrapper.
#
# One WhisperModel is loaded once (get_transcriber() is a lazy singleton) and
# reused across every WebSocket connection/chunk — loading it per-request
# would add seconds of latency to every transcription.

import numpy as np
from faster_whisper import WhisperModel

from .settings import STT_COMPUTE_TYPE, STT_DEVICE, STT_MODEL


class WhisperTranscriber:
    def __init__(self):
        self.model = WhisperModel(
            STT_MODEL,
            device=STT_DEVICE,
            compute_type=STT_COMPUTE_TYPE,
        )

    def transcribe_chunk(self, audio: np.ndarray, language: str = "ja") -> str:
        segments, info = self.model.transcribe(
            audio,
            language=language,
            task="transcribe",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
        )

        text = "".join(segment.text for segment in segments).strip()
        return text


_transcriber = None


def get_transcriber() -> WhisperTranscriber:
    global _transcriber
    if _transcriber is None:
        _transcriber = WhisperTranscriber()
    return _transcriber
