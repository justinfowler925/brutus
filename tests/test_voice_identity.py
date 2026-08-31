from pathlib import Path

import numpy as np

from brutus.voice_identity import VoiceIdentity


def test_owner_profile_stores_embedding_not_raw_recordings(tmp_path: Path):
    identity = VoiceIdentity(tmp_path / "voice-owner.json")
    identity._embedding = lambda _: np.array([1.0, 0.0], dtype=np.float32)  # type: ignore[method-assign]
    result = identity.enroll([b"one", b"two", b"three"])
    assert result["enrolled"] is True
    saved = (tmp_path / "voice-owner.json").read_text()
    assert "one" not in saved and "two" not in saved and "three" not in saved
    assert identity.verify(b"again")["accepted"] is True


def test_decode_rejects_non_wav_input(tmp_path: Path):
    identity = VoiceIdentity(tmp_path / "voice-owner.json")
    try:
        identity._decode_wav(b"not wav")
    except ValueError as exc:
        assert "valid WAV" in str(exc)
    else:
        raise AssertionError("invalid audio was accepted")
