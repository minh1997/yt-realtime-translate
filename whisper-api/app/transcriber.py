# transcriber.py — faster-whisper wrapper.
#
# One WhisperModel is loaded once (get_transcriber() is a lazy singleton) and
# reused across every WebSocket connection/chunk — loading it per-request
# would add seconds of latency to every transcription.
#
# Parameters are tuned for low latency + fewer missed segments on fast,
# continuous speech (see settings.py for the STT_BEAM_SIZE / STT_VAD_FILTER /
# STT_CONDITION_ON_PREVIOUS_TEXT env vars):
#   - vad_filter=False by default: VAD can strip speech during fast
#     continuous audio with little silence between words: safer to disable
#     it for this use case and let the rolling-window + merge strategy
#     (session.py / transcript_merge.py) handle continuity instead.
#   - condition_on_previous_text=True: helps the model stay consistent
#     across overlapping windows.
#   - beam_size=1 / best_of=1: greedy decoding, fastest.

import numpy as np
from faster_whisper import WhisperModel

from .settings import (
    STT_BEAM_SIZE,
    STT_COMPUTE_TYPE,
    STT_CONDITION_ON_PREVIOUS_TEXT,
    STT_DEVICE,
    STT_MODEL,
    STT_VAD_FILTER,
)


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
            beam_size=STT_BEAM_SIZE,
            best_of=1,
            vad_filter=STT_VAD_FILTER,
            condition_on_previous_text=STT_CONDITION_ON_PREVIOUS_TEXT,
            temperature=0.0,
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            word_timestamps=False,
        )

        text = "".join(segment.text for segment in segments).strip()
        return text


_transcriber = None


def get_transcriber() -> WhisperTranscriber:
    global _transcriber
    if _transcriber is None:
        _transcriber = WhisperTranscriber()
    return _transcriber
