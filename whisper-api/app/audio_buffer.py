# audio_buffer.py — rolling PCM audio buffer used by the /asr WebSocket route.
#
# Whisper is chunk-based, not true streaming ASR: every STT_CHUNK_SECONDS we
# hand the *most recent* window of audio to the model rather than transcribing
# sample-by-sample. AudioBuffer keeps a bounded rolling window (dropping older
# audio as new audio arrives) so memory stays constant no matter how long a
# livestream runs, and get_latest_chunk() adds a small overlap so words near a
# chunk boundary aren't cut off.

import numpy as np


class AudioBuffer:
    def __init__(self, sample_rate: int, max_seconds: float = 15.0):
        self.sample_rate = sample_rate
        self.max_samples = int(sample_rate * max_seconds)
        self._buffer = np.zeros(0, dtype=np.float32)

    def add_audio(self, audio: np.ndarray) -> None:
        if audio.size == 0:
            return
        self._buffer = np.concatenate([self._buffer, audio.astype(np.float32)])
        if self._buffer.size > self.max_samples:
            self._buffer = self._buffer[-self.max_samples :]

    def get_latest_chunk(self, seconds: float) -> np.ndarray:
        n = int(self.sample_rate * seconds)
        if n <= 0:
            return np.zeros(0, dtype=np.float32)
        return self._buffer[-n:]

    def duration_seconds(self) -> float:
        return self._buffer.size / float(self.sample_rate)
