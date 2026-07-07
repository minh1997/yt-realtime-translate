# session.py — per-connection ASR streaming session.
#
# Separates "receiving audio" from "transcribing audio" into two concurrent
# asyncio tasks so a slow/busy faster-whisper transcription never blocks the
# WebSocket receive loop — this was the root cause of missed speech during
# fast, continuous talking in the previous single-loop implementation:
#
#   receive_audio_loop()  — never awaits anything CPU-heavy; just appends
#                            incoming PCM to a RollingAudioBuffer and reports
#                            RMS/silence status. Runs for the whole
#                            connection lifetime, independent of whatever
#                            transcribe_loop() is doing.
#   transcribe_loop()     — wakes up every STT_STRIDE_SECONDS. If the
#                            previous transcription has already finished, it
#                            hands the *latest* STT_WINDOW_SECONDS (+overlap)
#                            of audio to faster-whisper via asyncio.to_thread
#                            (so the CPU-bound call doesn't block the event
#                            loop either). If the previous transcription is
#                            still running, this cycle is skipped — but the
#                            audio itself is never discarded, since it keeps
#                            accumulating in the RollingAudioBuffer
#                            regardless of whether/when it gets transcribed.
#
# Windows are deliberately much longer than the stride (default 8s window,
# 2s stride), so every window overlaps the previous one substantially — a
# transcription that runs a little long, or a skipped cycle, still gets
# picked back up by the next (longer, later) window instead of leaving a
# true gap in what's ever been transcribed.
#
# Because windows overlap, transcribe_loop() re-transcribes some
# already-seen audio on every cycle. merge_transcript() (transcript_merge.py)
# finds the longest matching suffix/prefix overlap between the running
# accumulated transcript and the newest window's raw transcription, so only
# genuinely new text is appended — this is what lets the transcript grow
# smoothly across windows instead of being replaced/reset every cycle.
#
# Finalization (turning accumulated text into a completed line for the UI +
# LLM translation) no longer depends solely on silence: the accumulated
# "since last final" tail is also flushed as a final ASR_TEXT every
# STT_FINALIZE_INTERVAL_SECONDS regardless, so a speaker who never pauses
# still gets periodic final lines instead of a partial that keeps growing
# forever and is never translated.

import asyncio
import logging
import time

import numpy as np

from .audio_buffer import RollingAudioBuffer
from .settings import (
    STT_FINALIZE_INTERVAL_SECONDS,
    STT_MAX_BUFFER_SECONDS,
    STT_OVERLAP_SECONDS,
    STT_SAMPLE_RATE,
    STT_STRIDE_SECONDS,
    STT_WINDOW_SECONDS,
)
from .transcriber import get_transcriber
from .transcript_merge import merge_transcript

logger = logging.getLogger("whisper_api.session")

SILENCE_RMS_THRESHOLD = 0.01
FINAL_SILENCE_SECONDS = 0.8
STATUS_REPORT_INTERVAL_SECONDS = 0.3

# How much extra audio (beyond the nominal window) to include in every
# transcription — purely to give merge_transcript() a wider chance of
# finding suffix/prefix overlap with the previous window near the boundary.
_EFFECTIVE_WINDOW_SECONDS = STT_WINDOW_SECONDS + STT_OVERLAP_SECONDS

# Safety cap on the internal (never normally trimmed) running transcript, so
# a multi-hour session doesn't grow it without bound. merge_transcript()'s
# cost only depends on the (short) new window text, so this is purely a
# memory safeguard, not a correctness requirement.
_TRANSCRIPT_TEXT_KEEP_CHARS = 20000


def normalize_text(text: str) -> str:
    return " ".join((text or "").strip().split())


class ASRSession:
    def __init__(self, websocket, config):
        self.websocket = websocket
        self.sample_rate = int(config.get("sampleRate") or STT_SAMPLE_RATE)
        self.language = config.get("language", "ja")

        self.audio_buffer = RollingAudioBuffer(self.sample_rate, max_seconds=STT_MAX_BUFFER_SECONDS)
        self.transcriber = get_transcriber()

        self.running = True
        self.transcribing = False

        # Full running merged transcript for the whole session — used only
        # as the "previous" argument to merge_transcript() so overlap
        # detection keeps working across finalize boundaries (finalizing
        # never resets this, it only moves finalized_len forward).
        self.transcript_text = ""
        # Length of transcript_text already flushed to the client as final.
        self.finalized_len = 0
        self.last_emitted_partial = ""
        self.last_finalize_at = time.monotonic()

        self.silence_started_at = None
        self._last_status_at = 0.0
        self._sequence = 0

    def _next_sequence(self) -> int:
        self._sequence += 1
        return self._sequence

    async def send_json(self, payload: dict) -> None:
        try:
            await self.websocket.send_json(payload)
        except Exception:
            self.running = False

    async def receive_audio_loop(self) -> None:
        try:
            while self.running:
                message = await self.websocket.receive()

                if message.get("type") == "websocket.disconnect":
                    break

                data = message.get("bytes")
                if data is None:
                    # Ignore any stray non-binary frames after config.
                    continue

                audio_i16 = np.frombuffer(data, dtype=np.int16)
                audio_f32 = audio_i16.astype(np.float32) / 32768.0
                self.audio_buffer.append(audio_f32)

                rms = float(np.sqrt(np.mean(audio_f32 ** 2))) if audio_f32.size else 0.0
                now = time.monotonic()

                if now - self._last_status_at >= STATUS_REPORT_INTERVAL_SECONDS:
                    self._last_status_at = now
                    await self.send_json(
                        {
                            "type": "ASR_STATUS",
                            "text": f"Receiving audio... RMS={rms:.3f}",
                            "rms": round(rms, 4),
                            "bufferSeconds": round(self.audio_buffer.duration_seconds(), 2),
                        }
                    )

                await self._update_silence(rms, now)
        except Exception:
            logger.exception("receive_audio_loop error")
        finally:
            self.running = False

    async def _update_silence(self, rms: float, now: float) -> None:
        if rms < SILENCE_RMS_THRESHOLD:
            if self.silence_started_at is None:
                self.silence_started_at = now
            elif now - self.silence_started_at >= FINAL_SILENCE_SECONDS:
                self.silence_started_at = None
                await self._finalize_pending()
        else:
            self.silence_started_at = None

    async def transcribe_loop(self) -> None:
        try:
            while self.running:
                await asyncio.sleep(STT_STRIDE_SECONDS)
                if not self.running:
                    break

                if self.transcribing:
                    # Previous transcription is still running — skip this
                    # cycle rather than starting an overlapping one. Audio
                    # keeps accumulating in the buffer regardless (nothing
                    # is lost); the next cycle just picks up a slightly
                    # longer "latest window".
                    continue

                if self.audio_buffer.duration_seconds() <= 0:
                    continue

                await self._run_transcription_cycle()

                pending = self.transcript_text[self.finalized_len :].strip()
                if pending and time.monotonic() - self.last_finalize_at >= STT_FINALIZE_INTERVAL_SECONDS:
                    await self._finalize_pending()
        except Exception:
            logger.exception("transcribe_loop error")
        finally:
            self.running = False

    async def _run_transcription_cycle(self) -> None:
        audio, start_sample, end_sample = self.audio_buffer.get_latest(_EFFECTIVE_WINDOW_SECONDS)
        if audio.size == 0:
            return

        self.transcribing = True
        started_at = time.monotonic()
        try:
            text = await asyncio.to_thread(self.transcriber.transcribe_chunk, audio, self.language)
            transcribe_duration = time.monotonic() - started_at
            audio_duration = audio.size / float(self.sample_rate)
            realtime_factor = (transcribe_duration / audio_duration) if audio_duration > 0 else 0.0

            logger.info(
                "window=[%d,%d] audio=%.2fs transcribe=%.2fs rtf=%.2f",
                start_sample,
                end_sample,
                audio_duration,
                transcribe_duration,
                realtime_factor,
            )

            if realtime_factor > 1.0:
                await self.send_json(
                    {
                        "type": "ASR_STATUS",
                        "text": "Warning: STT is slower than realtime. Consider a smaller model or longer stride.",
                    }
                )

            text = normalize_text(text)
            if not text:
                return

            merged, suffix = merge_transcript(self.transcript_text, text)
            if not suffix:
                # Nothing new in this window's transcription.
                return

            self.transcript_text = merged
            self._trim_transcript_text()

            pending = self.transcript_text[self.finalized_len :]
            if pending and pending != self.last_emitted_partial:
                self.last_emitted_partial = pending
                await self.send_json(
                    {
                        "type": "ASR_TEXT",
                        "text": pending,
                        "isFinal": False,
                        "engine": "faster-whisper",
                        "windowStartMs": int(start_sample / self.sample_rate * 1000),
                        "windowEndMs": int(end_sample / self.sample_rate * 1000),
                        "sequence": self._next_sequence(),
                    }
                )
        except Exception as exc:
            logger.exception("transcription cycle failed")
            await self.send_json({"type": "ASR_ERROR", "text": str(exc)})
        finally:
            self.transcribing = False

    def _trim_transcript_text(self) -> None:
        overflow = len(self.transcript_text) - _TRANSCRIPT_TEXT_KEEP_CHARS
        if overflow > 0:
            self.transcript_text = self.transcript_text[overflow:]
            self.finalized_len = max(0, self.finalized_len - overflow)

    async def _finalize_pending(self) -> None:
        pending = self.transcript_text[self.finalized_len :].strip()
        if not pending:
            return
        self.finalized_len = len(self.transcript_text)
        self.last_emitted_partial = ""
        self.last_finalize_at = time.monotonic()
        await self.send_json(
            {
                "type": "ASR_TEXT",
                "text": pending,
                "isFinal": True,
                "engine": "faster-whisper",
                "sequence": self._next_sequence(),
            }
        )

    async def finalize_remaining(self) -> None:
        """Flush any not-yet-finalized accumulated text — called once when
        the connection is closing, so the last few seconds of a session
        aren't silently lost as an un-finalized partial."""
        await self._finalize_pending()
