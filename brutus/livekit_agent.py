"""LiveKit voice worker that keeps Brutus's canonical conversation manager as the brain."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections import deque

import httpx
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession, StopResponse, llm
from livekit.plugins import elevenlabs, silero
from livekit.plugins.elevenlabs import VoiceSettings

from .config import load_config
from .voice_identity import VoiceIdentity

log = logging.getLogger("brutus.livekit")
BRUTUS_URL = os.environ.get("BRUTUS_URL", "http://127.0.0.1:8768")


class OwnerVoiceGate:
    """Keep a short remote-audio window and verify it for every final turn."""

    def __init__(self, identity: VoiceIdentity | None = None) -> None:
        self.identity = identity or VoiceIdentity()
        self._frames: deque[bytes] = deque()
        self._bytes = 0
        self.sample_rate = 16000
        self._limit = self.sample_rate * 2 * 8

    async def observe(self, track: rtc.AudioTrack) -> None:
        stream = rtc.AudioStream(track, sample_rate=self.sample_rate, num_channels=1)
        try:
            async for event in stream:
                data = bytes(event.frame.data)
                self._frames.append(data)
                self._bytes += len(data)
                while self._bytes > self._limit:
                    self._bytes -= len(self._frames.popleft())
        finally:
            await stream.aclose()

    async def accepts_current_speaker(self) -> bool:
        # A decision over less than two seconds is too easy to make from room
        # noise. Silence and an unenrolled profile fail closed.
        if self._bytes < self.sample_rate * 2 * 2:
            return False
        pcm = b"".join(self._frames)
        verdict = await asyncio.to_thread(self.identity.verify_pcm, pcm, self.sample_rate)
        return bool(verdict.get("accepted"))


def session_id_from_room(room_name: str) -> str:
    match = re.fullmatch(r"brutus-([0-9a-f]{12})-[0-9a-f]{8}", room_name)
    if not match:
        raise ValueError(f"invalid Brutus voice room: {room_name}")
    return match.group(1)


class BrutusVoiceAgent(Agent):
    def __init__(self, session_id: str, gate: OwnerVoiceGate) -> None:
        super().__init__(instructions="Brutus voice transport; the canonical manager supplies every reply.")
        self.session_id = session_id
        self.gate = gate

    async def _reply(self, message: str) -> str:
        async with httpx.AsyncClient(timeout=150.0) as client:
            response = await client.post(
                f"{BRUTUS_URL}/api/session/{self.session_id}/say",
                json={
                    "message": message,
                    "channel": "voice",
                    "read_only": False,
                    "wait": True,
                },
            )
            response.raise_for_status()
            payload = response.json()
        return str(payload.get("reply") or "I couldn't finish that turn. Please try again.")

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        """Hand the finalized transcript to Brutus and schedule its reply directly."""
        message = (new_message.text_content or "").strip()
        if message and not await self.gate.accepts_current_speaker():
            log.warning("owner voice rejected session=%s", self.session_id)
            raise StopResponse()
        log.info("canonical turn session=%s chars=%s", self.session_id, len(message))
        if message:
            reply = await self._reply(message)
            self.session.say(reply, allow_interruptions=True, add_to_chat_ctx=True)
        raise StopResponse()

    async def llm_node(self, chat_ctx, tools, model_settings):
        """Fallback for explicit session.generate_reply calls."""
        user_messages = [m for m in chat_ctx.messages() if m.role == "user" and m.text_content]
        return await self._reply(user_messages[-1].text_content.strip()) if user_messages else ""


class CanonicalBrainMarker(llm.LLM):
    """Makes LiveKit schedule LLM turns; BrutusVoiceAgent.llm_node owns generation."""

    @property
    def model(self) -> str:
        return "brutus-canonical-manager"

    @property
    def provider(self) -> str:
        return "brutus"

    def chat(self, **kwargs):
        raise RuntimeError("canonical replies must pass through BrutusVoiceAgent.llm_node")


async def entrypoint(ctx: agents.JobContext) -> None:
    await ctx.connect()
    session_id = session_id_from_room(ctx.room.name)
    api_key = os.environ["ELEVENLABS_API_KEY"]
    # The fallback browser player and LiveKit must use the same configured
    # identity. An environment-only LiveKit value made one conversation start
    # in one voice and continue in another after transport handoff.
    configured_voice_id = load_config().voice.elevenlabs_voice_id.strip()
    voice_id = configured_voice_id or os.environ.get("ELEVENLABS_VOICE_ID") or "hpp4J3VqNfWAUOO0d1Us"
    gate = OwnerVoiceGate()
    session = AgentSession(
        stt=elevenlabs.STT(
            api_key=api_key,
            # Batch-on-local-VAD is deliberate. ElevenLabs realtime Scribe
            # produced interim text but failed to commit the final turn in the
            # production-shaped LiveKit eval; exact transcripts matter more
            # here than shaving the STT call below one second.
            model="scribe_v2",
            language_code="en",
            tag_audio_events=False,
        ),
        tts=elevenlabs.TTS(
            api_key=api_key,
            model="eleven_flash_v2_5",
            voice_id=voice_id,
            voice_settings=VoiceSettings(stability=0.5, similarity_boost=0.8, speed=1.0),
            streaming_latency=2,
        ),
        llm=CanonicalBrainMarker(),
        vad=silero.VAD.load(),
        # Browser WebRTC already supplies echo cancellation. LiveKit's default
        # three-second warmup replaces mic audio with silence at the STT input,
        # which makes early barge-in look detected by VAD but lose every word.
        aec_warmup_duration=None,
        turn_handling={
            "endpointing": {"min_delay": 0.45, "max_delay": 2.5},
            "interruption": {
                "enabled": True,
                # Batch Scribe has no interim words. The adaptive overlap
                # classifier can therefore suppress the finalized batch as a
                # backchannel. VAD mode stops speech after 250 ms and retains
                # the full batch for the next canonical turn.
                "mode": "vad",
                "min_duration": 0.25,
                "min_words": 0,
                "false_interruption_timeout": 1.2,
                "resume_false_interruption": True,
                "backchannel_boundary": None,
            },
            "preemptive_generation": {"enabled": False},
        },
    )

    @ctx.room.on("track_subscribed")
    def _on_track(track, _publication, participant) -> None:
        if participant.is_local or track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        asyncio.create_task(gate.observe(track))

    @session.on("user_state_changed")
    def _on_user_state(event) -> None:
        log.info("voice user state session=%s state=%s", session_id, event.new_state)

    @session.on("user_input_transcribed")
    def _on_transcript(event) -> None:
        log.info(
            "voice transcript session=%s final=%s chars=%s",
            session_id,
            event.is_final,
            len(event.transcript or ""),
        )
    await session.start(agent=BrutusVoiceAgent(session_id, gate), room=ctx.room)
    log.info("voice room connected room=%s session=%s", ctx.room.name, session_id)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            host=os.environ.get("BRUTUS_VOICE_HEALTH_HOST", "127.0.0.1"),
            port=int(os.environ.get("BRUTUS_VOICE_HEALTH_PORT", "8096")),
        )
    )


if __name__ == "__main__":
    main()
