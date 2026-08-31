from __future__ import annotations

import json
from subprocess import CompletedProcess
from unittest.mock import patch

from brutus.config import BrutusCfg
from brutus.model_gateway import default_profile, run_profile
from brutus.model_profiles import select_model_profile


def test_frontier_profile_explicitly_selects_codex_sol():
    selected = select_model_profile(default_profile("frontier", BrutusCfg()))
    assert (selected.provider, selected.model) == ("codex", "gpt-5.6-sol")


def test_frontier_codex_is_ephemeral_read_only_and_returns_receipt(tmp_path):
    event = {"item": {"type": "agent_message", "text": "Use the existing ticket."}}
    proc = CompletedProcess([], 0, stdout=json.dumps(event) + "\n", stderr="")
    with (
        patch("brutus.model_gateway.shutil.which", return_value="/bin/codex"),
        patch("brutus.model_gateway.subprocess.run", return_value=proc) as run,
    ):
        result = run_profile(BrutusCfg(), "frontier", "resolve this", cwd=tmp_path)

    command = run.call_args.args[0]
    assert "--ephemeral" in command
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert result["ok"] is True
    assert result["provider"] == "codex"
    assert result["reply"] == "Use the existing ticket."
