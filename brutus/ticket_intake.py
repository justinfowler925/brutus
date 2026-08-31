"""Deterministic conversational intake for an explicitly requested Linear draft.

The conversation model remains responsible for open-ended work.  This module
handles the one place where a text-only tool protocol proved unreliable: a
user who has already stated a complete Unfog contract and asks to draft it.
It never writes a ticket; its output still crosses ``compile_unfog_work`` and
the normal approval artifact gate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


_REQUEST = re.compile(
    r"\b(?:new|create|open|draft|file|make)\s+(?:a\s+)?(?:linear\s+)?ticket\b|\bticket\s*:",
    re.IGNORECASE,
)
_CONTINUE = re.compile(r"\b(?:draft|create|open|file)\s+(?:it|this|that|the ticket)\b", re.IGNORECASE)
_FIELD = re.compile(
    r"(?:^|\n)\s*(title|outcome|target|premise|scope|preservation|acceptance|delivery)\s*:\s*",
    re.IGNORECASE,
)
_REQUIRED = ("outcome", "target", "premise", "scope", "preservation", "acceptance", "delivery")


@dataclass(frozen=True)
class TicketIntake:
    """An inert proposal input reconstructed only from the user's own words."""

    requested: bool
    fields: dict[str, str | tuple[str, ...]]

    @property
    def missing(self) -> tuple[str, ...]:
        return tuple(name for name in _REQUIRED if not self.fields.get(name))

    @property
    def ready(self) -> bool:
        return self.requested and not self.missing

    def args(self) -> dict[str, Any]:
        if not self.ready:
            raise ValueError("ticket intake is incomplete")
        title = str(self.fields.get("title") or self.fields["outcome"]).strip()
        return {
            "title": title,
            **{name: self.fields[name] for name in _REQUIRED},
            "evidence": [{
                "claim": "ticket contract supplied by Justin",
                "source": "conversation",
                "observation": "all seven Unfog fields were explicitly provided",
            }],
            "draft_title": title,
        }


def compile_ticket_intake(history: list[dict[str, Any]]) -> TicketIntake:
    """Collect labelled fields from user turns when the newest turn requests a ticket.

    We deliberately do not let assistant prose fill a field.  A user can give
    the contract across several turns, then say "draft the ticket"; unrelated
    historical fields are excluded because only turns after the most recent
    explicit ticket request are considered.
    """
    users = [str(item.get("content") or "") for item in history if item.get("role") == "user"]
    if not users:
        return TicketIntake(False, {})
    starts = [index for index, value in enumerate(users) if _REQUEST.search(value)]
    if not starts:
        return TicketIntake(False, {})
    latest = users[-1]
    if not (_REQUEST.search(latest) or _FIELD.search(latest) or _CONTINUE.search(latest)):
        return TicketIntake(False, {})
    start = starts[-1]
    values: dict[str, str | tuple[str, ...]] = {}
    for message in users[start:]:
        # Let a natural opener such as "new ticket: outcome: …" behave like
        # the line-oriented voice dictation form without making the field
        # matcher permissive enough to mine arbitrary prose.
        message = re.sub(
            r"\bticket:\s*(?=(?:title|outcome|target|premise|scope|preservation|acceptance|delivery)\s*:)",
            "ticket:\n",
            message,
            flags=re.IGNORECASE,
        )
        matches = list(_FIELD.finditer(message))
        for index, match in enumerate(matches):
            key = match.group(1).casefold()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(message)
            value = message[match.end():end].strip(" \t\r\n;.")
            if not value:
                continue
            if key == "acceptance":
                items = tuple(part.strip(" -\t.") for part in re.split(r"(?:\n|;)+", value) if part.strip(" -\t."))
                if items:
                    values[key] = items
            else:
                values[key] = value
    return TicketIntake(True, values)


def intake_question(intake: TicketIntake) -> str:
    """One focused, non-model question for only execution-changing omissions."""
    labels = ", ".join(intake.missing)
    return f"For that ticket draft, give me: {labels}. I’ll compile it, check for duplicate work, then queue the review."
