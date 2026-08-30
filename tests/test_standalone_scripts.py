"""Standalone installation and deploy cannot revive the Atlas tunnel."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_install_persistently_disables_atlas_tunnel():
    script = (ROOT / "scripts" / "install-brutus.sh").read_text()
    assert 'launchctl disable "gui/$(id -u)/com.clearspeed.brutus-tunnel"' in script
    assert "launchctl bootstrap" not in script[script.index("# Atlas is intentionally ignored") : script.index("# Laptop Brutus UI/API")]


def test_deploy_disables_and_skips_atlas_tunnel_verification():
    script = (ROOT / "scripts" / "deploy.sh").read_text()
    assert 'if [ "$NAME" = "com.clearspeed.brutus-tunnel.plist" ]' in script
    assert 'launchctl disable "gui/$(id -u)/com.clearspeed.brutus-tunnel"' in script
    assert 'unload_job "com.clearspeed.brutus-tunnel"' in script
