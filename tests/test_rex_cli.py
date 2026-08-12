from __future__ import annotations

import importlib.util
import io
import json
import os
import stat
import tempfile
import textwrap
import unittest
from datetime import datetime
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

# Codex reports usage as a running session total, so the fake does too: the Nth
# call for a given session id reports N times the per-turn figure.
counter = log_path.parent / ("usage-" + session_id + ".count")
turn_number = (int(counter.read_text()) if counter.exists() else 0) + 1
counter.write_text(str(turn_number))

def emit_usage():
    print(json.dumps({"type": "turn.completed", "usage": {
        "input_tokens": int(os.environ.get("FAKE_CODEX_INPUT_TOKENS", "100")) * turn_number,
        "cached_input_tokens": int(os.environ.get("FAKE_CODEX_CACHED_TOKENS", "40")) * turn_number,
        "output_tokens": int(os.environ.get("FAKE_CODEX_OUTPUT_TOKENS", "20")) * turn_number,
    }}))

if is_resume and os.environ.get("FAKE_CODEX_MISSING") == "1":
    marker = Path(os.environ["FAKE_CODEX_MISSING_MARKER"])
    if not marker.exists():
        marker.write_text("failed once", encoding="utf-8")
        if os.environ.get("FAKE_CODEX_USAGE_BEFORE_FAILURE") == "1":
            emit_usage()
        template = os.environ.get(
            "FAKE_CODEX_MISSING_MESSAGE", "Session not found for thread_id: {id}"
        )
        stream = sys.stdout if os.environ.get("FAKE_CODEX_MISSING_ON_STDOUT") == "1" else sys.stderr
        print(template.format(id=session_id), file=stream)
        raise SystemExit(1)

if not is_resume and os.environ.get("FAKE_CODEX_FAIL_BOOTSTRAP") == "1":
    if os.environ.get("FAKE_CODEX_USAGE_BEFORE_FAILURE") == "1":
        emit_usage()
    print("codex exec failed: model unavailable", file=sys.stderr)
    raise SystemExit(1)

output_path.write_text("rex response\n", encoding="utf-8")
print(json.dumps({"type": "thread.started", "thread_id": session_id}))
emit_usage()
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

    def records(self):
        path = rex_cli.invocation_log_path(self.state_dir)
        return [json.loads(line) for line in path.read_text().splitlines()]

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

    def test_marker_in_codex_output_does_not_discard_the_session(self):
        """Rex's own words are not transport diagnostics.

        `--json` event output is model-influenced. A resume that fails for an
        unrelated reason while a marker phrase sits in stdout must not be read as
        "the session is gone" - that would cost a live session.
        """
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "55555555-5555-5555-5555-555555555555"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "stdout-marker")
        os.environ["FAKE_CODEX_MISSING_ON_STDOUT"] = "1"
        os.environ["FAKE_CODEX_MISSING_MESSAGE"] = (
            "the user asked what happens when a session not found error appears"
        )
        with self.assertRaises(rex_cli.RexError):
            self.invoke("quoting a marker")
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(
            rex_cli.read_session_id(self.state_dir),
            "55555555-5555-5555-5555-555555555555",
        )

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

    def test_success_records_invocation_metrics(self):
        self.assertEqual(self.invoke(), "rex response")
        records = self.records()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertTrue(record["success"])
        self.assertFalse(record["started_with_session"])
        self.assertEqual(record["attempts"], 1)
        self.assertFalse(record["recovery_attempted"])
        self.assertFalse(record["recovery_succeeded"])
        self.assertEqual(record["version"], 2)
        self.assertEqual(record["session_input_tokens"], 100)
        self.assertEqual(record["session_cached_input_tokens"], 40)
        self.assertEqual(record["session_output_tokens"], 20)
        self.assertEqual(record["call_input_tokens"], 100)
        self.assertEqual(record["call_cached_input_tokens"], 40)
        self.assertEqual(record["call_output_tokens"], 20)
        self.assertIsNone(record["cost_usd"])
        self.assertIsNone(record["failure_kind"])
        self.assertGreater(record["duration_seconds"], 0)
        parsed = datetime.strptime(record["started_at"], "%Y-%m-%dT%H:%M:%S.%f%z")
        self.assertEqual(parsed.utcoffset().total_seconds(), 0)
        mode = stat.S_IMODE(
            rex_cli.invocation_log_path(self.state_dir).stat().st_mode
        )
        self.assertEqual(mode, 0o600)

    def test_resume_records_started_with_session(self):
        self.invoke("first")
        self.invoke("second")
        records = self.records()
        self.assertEqual(len(records), 2)
        second = records[1]
        self.assertTrue(second["started_with_session"])
        self.assertEqual(second["attempts"], 1)
        self.assertFalse(second["recovery_attempted"])
        self.assertFalse(second["recovery_succeeded"])
        # The session counter has advanced; the call cost has not.
        self.assertEqual(second["session_input_tokens"], 200)
        self.assertEqual(second["session_output_tokens"], 40)
        self.assertEqual(second["call_input_tokens"], 100)
        self.assertEqual(second["call_output_tokens"], 20)

    def test_recovery_does_not_add_the_dead_session_to_the_new_one(self):
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "66666666-6666-6666-6666-666666666666"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "recovered")
        os.environ["FAKE_CODEX_USAGE_BEFORE_FAILURE"] = "1"
        self.assertEqual(self.invoke("recover"), "rex response")
        record = self.records()[0]
        self.assertTrue(record["success"])
        self.assertTrue(record["started_with_session"])
        self.assertEqual(record["attempts"], 2)
        self.assertTrue(record["recovery_attempted"])
        self.assertTrue(record["recovery_succeeded"])
        # Both attempts reported a cumulative total of 100. Adding them would claim
        # this call cost 200 and charge the dead session's lifetime to the new one.
        self.assertEqual(record["session_input_tokens"], 100)
        self.assertEqual(record["session_cached_input_tokens"], 40)
        self.assertEqual(record["session_output_tokens"], 20)
        self.assertEqual(record["call_input_tokens"], 100)
        self.assertEqual(record["call_output_tokens"], 20)

    def test_unknown_baseline_records_a_null_call_cost(self):
        """A missing baseline is recorded as unknown, never as a guessed delta."""
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "99999999-9999-9999-9999-999999999999"
        )
        self.assertEqual(self.invoke("no baseline on disk"), "rex response")
        record = self.records()[0]
        self.assertTrue(record["started_with_session"])
        self.assertEqual(record["session_input_tokens"], 100)
        self.assertIsNone(record["call_input_tokens"])
        self.assertIsNone(record["call_cached_input_tokens"])
        self.assertIsNone(record["call_output_tokens"])

    def test_baseline_from_another_session_is_ignored(self):
        self.invoke("first")
        baseline = json.loads(
            rex_cli.usage_baseline_path(self.state_dir).read_text()
        )
        self.assertEqual(baseline["session_id"], "11111111-1111-1111-1111-111111111111")
        rex_cli.write_usage_baseline(
            self.state_dir, "not-the-live-session", {"input_tokens": 99999}
        )
        self.invoke("second")
        self.assertIsNone(self.records()[1]["call_input_tokens"])

    def test_failed_recovery_is_recorded(self):
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "77777777-7777-7777-7777-777777777777"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "failed-recovery")
        os.environ["FAKE_CODEX_FAIL_BOOTSTRAP"] = "1"
        with self.assertRaises(rex_cli.RexError):
            self.invoke("recover into a wall")
        record = self.records()[0]
        self.assertFalse(record["success"])
        self.assertEqual(record["attempts"], 2)
        self.assertTrue(record["recovery_attempted"])
        self.assertFalse(record["recovery_succeeded"])
        self.assertEqual(record["failure_kind"], "codex_error")

    def test_unrelated_failure_records_failure_without_recovery(self):
        self.state_dir.mkdir()
        rex_cli.write_session_id(
            self.state_dir, "88888888-8888-8888-8888-888888888888"
        )
        os.environ["FAKE_CODEX_MISSING"] = "1"
        os.environ["FAKE_CODEX_MISSING_MARKER"] = str(self.root / "unrelated")
        os.environ["FAKE_CODEX_MISSING_MESSAGE"] = "stream error: connection reset"
        with self.assertRaises(rex_cli.RexError):
            self.invoke("transient")
        self.assertEqual(
            rex_cli.read_session_id(self.state_dir),
            "88888888-8888-8888-8888-888888888888",
        )
        record = self.records()[0]
        self.assertFalse(record["success"])
        self.assertEqual(record["attempts"], 1)
        self.assertFalse(record["recovery_attempted"])
        self.assertFalse(record["recovery_succeeded"])
        self.assertEqual(record["failure_kind"], "codex_error")

    def test_usage_parser_ignores_untrusted_shapes(self):
        stream = "\n".join(
            [
                "not json at all",
                json.dumps({"type": "thread.started", "thread_id": "x"}),
                json.dumps({"type": "turn.completed"}),
                json.dumps({"type": "turn.completed", "usage": "nope"}),
                json.dumps(
                    {
                        "type": "turn.completed",
                        "usage": {
                            "input_tokens": True,
                            "cached_input_tokens": -5,
                            "output_tokens": "12",
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "turn.completed",
                        "usage": {"input_tokens": 7, "output_tokens": 3},
                    }
                ),
            ]
        )
        self.assertEqual(
            rex_cli.parse_token_usage(stream),
            {"input_tokens": 7, "output_tokens": 3},
        )
        self.assertIsNone(rex_cli.parse_token_usage("nothing useful here"))

    def test_lock_timeout_records_zero_attempts(self):
        lock_handle = rex_cli.acquire_lock(self.state_dir, 1)
        try:
            with self.assertRaisesRegex(rex_cli.RexError, "Rex is busy"):
                self.invoke("blocked")
        finally:
            rex_cli.fcntl.flock(lock_handle.fileno(), rex_cli.fcntl.LOCK_UN)
            lock_handle.close()
        record = self.records()[0]
        self.assertFalse(record["success"])
        self.assertEqual(record["attempts"], 0)
        self.assertEqual(record["failure_kind"], "lock_timeout")

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
