"""Run `modal deploy backend/deploy/modal_app.py` from the project root."""
from pathlib import Path
import subprocess
import modal

BACKEND = Path(__file__).resolve().parents[1]
image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .add_local_file(BACKEND / "package.json", "/app/backend/package.json", copy=True)
    .add_local_file(BACKEND / "package-lock.json", "/app/backend/package-lock.json", copy=True)
    .run_commands("cd /app/backend && npm ci --omit=dev --ignore-scripts")
    .add_local_dir(BACKEND / "src", "/app/backend/src")
)
app = modal.App("voice-companion")


@app.function(
    image=image,
    cpu=1,
    memory=512,
    min_containers=1,
    max_containers=1,
    buffer_containers=0,
    scaledown_window=30,
    timeout=3600,
    secrets=[modal.Secret.from_name("voice-companion")],
)
@modal.concurrent(max_inputs=20)
@modal.web_server(8787, startup_timeout=30)
def backend():
    import os
    environment = {
        **os.environ,
        "HOST": "0.0.0.0",
        "PORT": "8787",
        "SERVER_STT_PROVIDER": os.environ.get("SERVER_STT_PROVIDER", "none"),
        # Temporary, bounded diagnostics for the reported Muse rejection.
        "MUSE_DEBUG_RESPONSES": "1",
    }
    subprocess.Popen(["node", "src/server.js"], cwd="/app/backend", env=environment)
