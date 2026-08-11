from __future__ import annotations

import importlib.util
import io
import json
import os
import stat
import tempfile
import textwrap
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "src" / "rex_cli.py"
SPEC = importlib.util.spec_from_file_location("rex_cli", MODULE_PATH)
assert SPEC and SPEC.loader
rex_cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rex_cli)


FAKE_CODEX = r'''#!/usr/bin/env python3
import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
prompt = sys.stdin.read()
log_path = Path(os.environ["FAKE_CODEX_LOG"])
with log_path.open("a", encoding="utf-8") as log:
    log.write(json.dumps({"args": args, "prompt": prompt}) + "\n")

sleep_for = float(os.environ.get("FAKE_CODEX_SLEEP", "0"))
if sleep_for:
    time.sleep(sleep_for)

output_flag = args.index("--output-last-message")
output_path = Path(args[output_flag + 1])
is_resume = "resume" in args
session_id = args[args.index("resume") + 1] if is_resume else "11111111-1111-1111-1111-111111111111"

if is_resume and os.environ.get("FAKE_CODEX_MISSING") == "1":
    marker = Path(os.environ["FAKE_CODEX_MISSING_MARKER"])
    if not marker.exists():
        marker.write_text("failed once", encoding="utf-8")
        template = os.environ.get(
            "FAKE_CODEX_MISSING_MESSAGE", "Session not found for thread_id: {id}"
        )
        print(template.format(id=session_id), file=sys.stderr)
        raise SystemExit(1)

output_path.write_text("rex response\n", encoding="utf-8")
print(json.dumps({"type": "thread.started", "thread_id": session_id}))
'''


class RexCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state_dir = self.root / "state"
        self.repo_root = self.root / "repo"
        self.repo_root.mkdir()
        self.log_path = self.root / "codex.log"
        self.fake_codex = self.root / "fake-codex"
        self.fake_codex.write_text(textwrap.dedent(FAKE_CODEX), encoding="utf-8")
        self.fake_codex.chmod(self.fake_codex.stat().st_mode | stat.S_IXUSR)
        self.environment = {
            "FAKE_CODEX_LOG": str(self.log_path),
        }
        self.previous_environment = os.environ.copy()
        os.environ.update(self.environment)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.previous_environment)
        self.temporary.cleanup()

    def calls(self):
        return [json.loads(line) for line in self.log_path.read_text().splitlines()]

    def invoke(self, prompt="hello"):
        return rex_cli.ask(
            prompt=prompt,
            state_dir=self.state_dir,
            repo_root=self.repo_root,
            codex_binary=str(self.fake_codex),
            lock_timeout=1,
        )

    def test_first_call_bootstraps_and_persists_thread(self):
        self.assertEqual(self.invoke(), "rex response")
        state = json.loads((self.state_dir / "state.json").read_text())
        self.assertEqual(
            state["session_id"], "11111111-1111-1111-1111-111111111111"
        )
        call = self.calls()[0]
        self.assertNotIn("resume", call["args"])
        self.assertIn("one-time bootstrap", call["prompt"])
        self.assertIn("hello", call["prompt"])
        self.assertIn("read-only", call["args"])

    def test_later_call_resumes_without_bootstrap(self):
        self.invoke("first")
        self.invoke("second")
        call = self.calls()[1]
        self.assertIn("resume", call["args"])
        self.assertEqual(call["prompt"], "second")
        self.assertNotIn("one-time bootstrap", call["prompt"])

    def test_missing_session_creates_and_bootstraps_replacement(self):
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "22222222-2222-2222-2222-222222222222"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "missing")
        self.assertEqual(self.invoke("recover"), "rex response")
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertIn("resume", calls[0]["args"])
        self.assertNotIn("resume", calls[1]["args"])
        self.assertIn("one-time bootstrap", calls[1]["prompt"])

    def test_pruned_rollout_is_recovered_like_a_missing_session(self):
        """The phrasing `codex exec resume` actually uses for a pruned rollout."""
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "33333333-3333-3333-3333-333333333333"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "pruned")
        os.environ["FAKE_CODEX_MISSING_MESSAGE"] = (
            "thread/resume: thread/resume failed: no rollout found for "
            "thread id {id} (code -32600)"
        )
        self.assertEqual(self.invoke("recover"), "rex response")
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertIn("resume", calls[0]["args"])
        self.assertNotIn("resume", calls[1]["args"])
        self.assertIn("one-time bootstrap", calls[1]["prompt"])

    def test_unrelated_resume_failure_keeps_the_session(self):
        """A transient failure must not throw away Rex's continuity."""
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "44444444-4444-4444-4444-444444444444"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "transient")
        os.environ["FAKE_CODEX_MISSING_MESSAGE"] = "stream error: connection reset"
        with self.assertRaises(rex_cli.RexError):
            self.invoke("transient")
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(
            rex_cli.read_session_id(self.state_dir),
            "44444444-4444-4444-4444-444444444444",
        )

    def test_corrupt_state_fails_closed(self):
        self.state_dir.mkdir()
        (self.state_dir / "state.json").write_text("not json", encoding="utf-8")
        with self.assertRaisesRegex(rex_cli.RexError, "Cannot read Rex state"):
            self.invoke()
        self.assertFalse(self.log_path.exists())

    def test_second_invocation_times_out_while_rex_is_locked(self):
        lock_handle = rex_cli.acquire_lock(self.state_dir, 1)
        try:
            with self.assertRaisesRegex(rex_cli.RexError, "Rex is busy"):
                rex_cli.ask(
                    prompt="blocked",
                    state_dir=self.state_dir,
                    repo_root=self.repo_root,
                    codex_binary=str(self.fake_codex),
                    lock_timeout=0.05,
                )
        finally:
            rex_cli.fcntl.flock(lock_handle.fileno(), rex_cli.fcntl.LOCK_UN)
            lock_handle.close()

    def test_mcp_server_exposes_only_ask_rex(self):
        requests = "\n".join(
            [
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {"protocolVersion": "2024-11-05"},
                    }
                ),
                json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json.dumps(
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
                ),
            ]
        )
        output = io.StringIO()
        self.assertEqual(rex_cli.serve_mcp(io.StringIO(requests), output), 0)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(responses[0]["result"]["serverInfo"]["name"], "rex")
        tools = responses[1]["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["ask_rex"])


if __name__ == "__main__":
    unittest.main()
