# transcript_merge.py — merges an overlapping transcription window into the
# session's running accumulated transcript.
#
# Because transcription windows overlap on purpose (see session.py — the
# window is much longer than the stride, so a slow/skipped cycle still
# overlaps the next one instead of leaving a gap), every call to
# faster-whisper re-transcribes some already-seen audio. Two naive
# strategies both fail:
#   - Replacing old text with the fresh transcription makes previously-seen
#     words vanish as soon as they scroll out of a single window (this was
#     the root cause of missed transcript segments during fast, continuous
#     speech with no silence to trigger finalization).
#   - Dropping a new transcription just because it "looks similar" to the
#     old one risks silently discarding genuinely new speech.
#
# Instead, this finds the longest suffix of `previous` that matches a
# prefix of `current` (plain character-level comparison — this works for
# Japanese, which has no spaces between words, as well as English/
# Vietnamese) and appends only the non-overlapping remainder of `current`.


def normalize_whitespace(text: str) -> str:
    return " ".join((text or "").strip().split())


def _longest_suffix_prefix_overlap(previous: str, current: str) -> int:
    max_overlap = min(len(previous), len(current))
    for k in range(max_overlap, 0, -1):
        if previous[-k:] == current[:k]:
            return k
    return 0


def merge_transcript(previous: str, current: str) -> tuple[str, str]:
    """Merge a new window's raw transcription (`current`) into the running
    accumulated transcript (`previous`).

    Returns (merged_full_text, new_suffix_text). `new_suffix_text` is empty
    when `current` contributed nothing new (e.g. it's identical to, or a
    subset of, the tail of `previous`) — callers should treat an empty
    suffix as "nothing changed, don't re-emit".
    """
    previous = normalize_whitespace(previous)
    current = normalize_whitespace(current)

    if not current:
        return previous, ""
    if not previous:
        return current, current
    if current == previous:
        return previous, ""

    overlap = _longest_suffix_prefix_overlap(previous, current)
    suffix = current[overlap:]

    if not suffix:
        # current is fully contained in / equal to the tail of previous.
        return previous, ""

    # No overlap found at all: rather than dropping `current` (it may be
    # genuinely new speech the model just phrased differently across window
    # boundaries), keep both — accepting a small risk of duplicated wording
    # in exchange for never silently losing content.
    merged = previous + suffix
    return merged, suffix
