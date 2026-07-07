# audio_buffer.py — thread-safe rolling PCM audio buffer with absolute
# sample indexing, used by the /asr WebSocket session (see session.py).
#
# Whisper is chunk-based, not true streaming ASR: every STT_STRIDE_SECONDS we
# hand the *latest* window of audio to the model rather than transcribing
# sample-by-sample. RollingAudioBuffer keeps a bounded rolling window
# (dropping older audio from the front as new audio arrives) so memory stays
# constant no matter how long a livestream runs.
#
# Every sample ever appended is assigned an absolute, ever-increasing sample
# index — get_range()/get_latest() return that range alongside the audio so
# callers (session.py) can log/report exactly which slice of the stream a
# given transcription covered, even after older audio has scrolled out of
# the buffer.
#
# receive_audio_loop() (appending) and transcribe_loop() (reading) run as
# two separate asyncio tasks on the same event loop, and the CPU-bound
# transcription itself happens on a snapshot (a plain numpy copy) handed off
# to a worker thread — but a threading.Lock is still used around every
# buffer access as a cheap, explicit safety net per the "thread-safe rolling
# buffer" requirement, rather than relying on asyncio's single-threaded
# cooperative scheduling as an implicit guarantee.

import threading

import numpy as np


class RollingAudioBuffer:
    def __init__(self, sample_rate: int, max_seconds: float = 60.0):
        self.sample_rate = sample_rate
        self.max_samples = max(1, int(sample_rate * max_seconds))
        self._buffer = np.zeros(0, dtype=np.float32)
        # Absolute sample index of self._buffer[0] — advances whenever old
        # audio is trimmed off the front to enforce max_samples.
        self._start_sample = 0
        # Absolute sample index one-past the last sample appended so far.
        self._end_sample = 0
        self._lock = threading.Lock()

    def append(self, audio: np.ndarray) -> tuple[int, int]:
        """Append audio (mono float32). Returns the absolute
        (start_sample, end_sample) range this call just added. Newly
        appended audio is never dropped — only already-buffered audio is
        trimmed off the *front* once max_samples is exceeded."""
        if audio.size == 0:
            with self._lock:
                return self._end_sample, self._end_sample

        audio = np.asarray(audio, dtype=np.float32)
        with self._lock:
            start_sample = self._end_sample
            self._buffer = np.concatenate([self._buffer, audio])
            self._end_sample += audio.size

            overflow = self._buffer.size - self.max_samples
            if overflow > 0:
                self._buffer = self._buffer[overflow:]
                self._start_sample += overflow

            return start_sample, self._end_sample

    def get_range(self, start_sample: int, end_sample: int) -> np.ndarray:
        """Return audio for an absolute sample range, clamped to whatever
        is still available (audio older than what's retained is silently
        clamped away rather than raising)."""
        with self._lock:
            lo = max(start_sample, self._start_sample)
            hi = min(end_sample, self._end_sample)
            if hi <= lo:
                return np.zeros(0, dtype=np.float32)
            offset = self._start_sample
            return self._buffer[lo - offset : hi - offset].copy()

    def get_latest(self, seconds: float) -> tuple[np.ndarray, int, int]:
        """Return the latest `seconds` of audio plus its absolute
        (start_sample, end_sample) range."""
        with self._lock:
            end_sample = self._end_sample
            n = int(self.sample_rate * seconds)
            start_sample = max(self._start_sample, end_sample - n)
            offset = self._start_sample
            audio = self._buffer[start_sample - offset : end_sample - offset].copy()
            return audio, start_sample, end_sample

    def latest_sample(self) -> int:
        with self._lock:
            return self._end_sample

    def duration_seconds(self) -> float:
        with self._lock:
            return self._buffer.size / float(self.sample_rate)

