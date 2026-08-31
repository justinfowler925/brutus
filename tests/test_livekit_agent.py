"""LiveKit transport keeps the configured Brutus voice identity."""

from pathlib import Path

import asyncio

from brutus.livekit_agent import OwnerVoiceGate


def test_livekit_uses_the_same_configured_voice_as_browser_tts():
    source = (Path(__file__).parents[1] / "brutus/livekit_agent.py").read_text()
    assert "from .config import load_config" in source
    assert "load_config().voice.elevenlabs_voice_id.strip()" in source


def test_owner_gate_fails_closed_without_enough_remote_audio():
    gate = OwnerVoiceGate()
    assert asyncio.run(gate.accepts_current_speaker()) is False


def test_livekit_checks_owner_audio_before_forwarding_any_turn():
    source = (Path(__file__).parents[1] / "brutus/livekit_agent.py").read_text()
    handler = source[source.index("async def on_user_turn_completed"):source.index("async def llm_node")]
    assert "await self.gate.accepts_current_speaker()" in handler
    assert "raise StopResponse()" in handler
