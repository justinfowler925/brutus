"""LiveKit transport keeps the configured Brutus voice identity."""

from pathlib import Path


def test_livekit_uses_the_same_configured_voice_as_browser_tts():
    source = (Path(__file__).parents[1] / "brutus/livekit_agent.py").read_text()
    assert "from .config import load_config" in source
    assert "load_config().voice.elevenlabs_voice_id.strip()" in source
