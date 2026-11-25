#!/usr/bin/env python3
# SPDX-License-Identifier: MulanPSL-2.0
"""Drive the real opencode TUI in a pty and prove the TUI part publishes focus.

The TUI renders through opentui and needs a terminal, so this spawns it under a
pseudo-terminal, submits one prompt, then quits. Success criterion: the server
log records a focus signal from the loopback channel, which only the TUI part
sends.

Usage: python3 e2e/tui-check.py <scratch-root> <opencode-config-json-dir> ...
       (the runner below builds the scratch environment itself)
"""
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TMP = REPO / "e2e" / ".tmp" / "tui"


def build_scratch() -> tuple[Path, subprocess.Popen, Path]:
    shutil.rmtree(TMP, ignore_errors=True)
    for name in ("cfg", "data", "state", "proj"):
        (TMP / name).mkdir(parents=True, exist_ok=True)
    (TMP / "proj" / "seed.txt").write_text("seed line\n" * 50)

    mock_log = TMP / "mock.log"
    mock = subprocess.Popen(
        ["node", str(REPO / "e2e" / "mock-upstream.mjs"), "--capture", str(TMP / "cap.jsonl"), "--mode", "B"],
        stdout=mock_log.open("wb"),
        stderr=subprocess.STDOUT,
    )
    port = None
    for _ in range(200):
        text = mock_log.read_text() if mock_log.exists() else ""
        if "PORT=" in text:
            port = text.split("PORT=")[1].split()[0]
            break
        time.sleep(0.05)
    if port is None:
        mock.kill()
        raise SystemExit("mock upstream did not start")

    config = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        "plugin": [[str(REPO), {"trace": {"enabled": True, "file": str(TMP / "trace.jsonl")}}]],
        "provider": {
            "mock": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Mock",
                "options": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "test"},
                "models": {"mock-model": {"name": "Mock", "limit": {"context": 200000, "output": 8192}}},
            }
        },
    }
    (TMP / "proj" / "opencode.json").write_text(json.dumps(config, indent=2))
    # opencode 1.18 loads TUI parts from tui.json, not from the server plugin list.
    if os.environ.get("TUI_PLUGIN_FORM") == "tuple":
        tui_config = {"plugin": [[str(REPO), {}]]}
    else:
        tui_config = {"plugin": [str(REPO)]}
    (TMP / "cfg" / "opencode").mkdir(parents=True, exist_ok=True)
    (TMP / "cfg" / "opencode" / "tui.json").write_text(json.dumps(tui_config, indent=2))
    return TMP, mock, TMP / "data" / "opencode" / "log"


def run_tui(log_dir: Path) -> str:
    env = dict(os.environ)
    env.update(
        {
            "TERM": "xterm-256color",
            "COLUMNS": "140",
            "LINES": "45",
            "XDG_CONFIG_HOME": str(TMP / "cfg"),
            "XDG_DATA_HOME": str(TMP / "data"),
            "XDG_STATE_HOME": str(TMP / "state"),
            "AGENT_HINTS_TUI_DEBUG": "1",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
            "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "1",
        }
    )
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
    process = subprocess.Popen(
        ["opencode", "--print-logs", "--log-level", "DEBUG", "--model", "mock/mock-model"],
        cwd=TMP / "proj",
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)

    transcript = []

    def pump(seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(master, 65536)
            except OSError:
                return
            if not data:
                return
            transcript.append(data.decode("utf-8", "replace"))

    pump(14.0)
    # Dismiss any first-run dialog, then submit a prompt.
    os.write(master, b"\x1b")
    pump(0.5)
    os.write(master, b"hello there")
    pump(0.4)
    os.write(master, b"\r")
    pump(14.0)
    # Quit: two escapes then ctrl+c twice, then a hard kill as a fallback.
    os.write(master, b"\x03")
    pump(1.5)
    os.write(master, b"\x03")
    pump(1.0)
    if process.poll() is None:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        pump(1.5)
    if process.poll() is None:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    process.wait(timeout=5)
    os.close(master)
    return "".join(transcript)


def main() -> int:
    tmp, mock, log_dir = build_scratch()
    try:
        transcript = run_tui(log_dir)
        (tmp / "tui-transcript.txt").write_text(transcript)
        logs = ""
        if log_dir.exists():
            logs = "\n".join(path.read_text(errors="replace") for path in log_dir.glob("*.log"))
        haystack = logs + "\n" + transcript
        focus = [line for line in haystack.splitlines() if "focus signal" in line or "blur signal" in line]
        print(f"· tui transcript bytes: {len(transcript)}")
        print(f"· focus signals seen: {len(focus)}")
        for line in focus[:4]:
            print(f"  {line.strip()[:160]}")
        if not focus:
            print("✗ the real TUI never published a focus signal", file=sys.stderr)
            print(logs[-4000:], file=sys.stderr)
            return 1
        print("✓ real TUI part published focus signals over the loopback channel")
        return 0
    finally:
        mock.kill()


if __name__ == "__main__":
    raise SystemExit(main())
