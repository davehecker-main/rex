#!/usr/bin/env python3
"""On-demand entrypoint for the single persistent Rex Codex session."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import TextIO


STATE_VERSION = 1

# Codex has more than one way of saying "the session you asked me to resume is
# gone". Matching only the first of them left a dead pointer unrecoverable:
# `codex exec resume` answers a pruned rollout with "no rollout found for thread
# id <id> (code -32600)", which contains none of the words in "session not found".
UNRESUMABLE_SESSION_MARKERS = (
    "session not found",
    "no rollout found",
    "thread not found",
    "conversation not found",
)


class RexError(RuntimeError):
    """An expected Rex invocation failure."""


def is_unresumable_session(error_text: str) -> bool:
    """True when Codex is reporting that the stored session no longer exists."""
    lowered = error_text.lower()
    return any(marker in lowered for marker in UNRESUMABLE_SESSION_MARKERS)


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_state_dir() -> Path:
    override = os.environ.get("REX_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Application Support" / "Rex"


def state_path(state_dir: Path) -> Path:
    return state_dir / "state.json"


def read_session_id(state_dir: Path) -> str | None:
    path = state_path(state_dir)
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RexError(f"Cannot read Rex state at {path}: {error}") from error
    if state.get("version") != STATE_VERSION:
        raise RexError(f"Unsupported Rex state version in {path}")
    session_id = state.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise RexError(f"Rex state at {path} has no valid session_id")
    return session_id


def write_session_id(state_dir: Path, session_id: str) -> None:
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = json.dumps(
        {"version": STATE_VERSION, "session_id": session_id},
        indent=2,
        sort_keys=True,
    ) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        dir=state_dir, prefix="state.", suffix=".tmp", text=True
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, state_path(state_dir))
    finally:
        temporary_path.unlink(missing_ok=True)


def clear_session_id(state_dir: Path) -> None:
    state_path(state_dir).unlink(missing_ok=True)


def acquire_lock(state_dir: Path, timeout_seconds: float) -> TextIO:
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_handle = (state_dir / "invoke.lock").open("a+", encoding="utf-8")
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock_handle
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock_handle.close()
                raise RexError(
                    f"Rex is busy; timed out after {timeout_seconds:g} seconds"
                )
            time.sleep(0.1)


def bootstrap_prompt(repo_root: Path, prompt: str) -> str:
    return f"""You are Rex, the single persistent AI engineering advisor described by
the repository at {repo_root}. Before answering, read README.md, docs/charter.md,
docs/constitution.md, and docs/operating-model.md. Those files are authoritative.
ShareView is the issue-management system; this repository is Rex's durable memory.
Operate read-only. Advise, analyze, review, and propose, but do not modify files or
perform consequential actions. Important decisions must be promoted into the Rex
repository rather than existing only in this conversation.

This is your one-time bootstrap. Respond to the request below.

REQUEST:
{prompt}"""


def parse_thread_id(json_lines: str) -> str | None:
    for line in json_lines.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "thread.started":
            continue
        for key in ("thread_id", "threadId", "session_id", "sessionId"):
            value = event.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def codex_command(
    codex_binary: str,
    repo_root: Path,
    output_path: Path,
    session_id: str | None,
) -> list[str]:
    command = [
        codex_binary,
        "exec",
        "--sandbox",
        "read-only",
        "--cd",
        str(repo_root),
        "--json",
        "--output-last-message",
        str(output_path),
    ]
    if session_id:
        command.extend(["resume", session_id, "-"])
    else:
        command.append("-")
    return command


def invoke_codex(
    prompt: str,
    session_id: str | None,
    state_dir: Path,
    repo_root: Path,
    codex_binary: str,
) -> tuple[str, str]:
    descriptor, output_name = tempfile.mkstemp(
        dir=state_dir, prefix="response.", suffix=".txt", text=True
    )
    os.close(descriptor)
    output_path = Path(output_name)
    try:
        result = subprocess.run(
            codex_command(codex_binary, repo_root, output_path, session_id),
            input=prompt,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            detail = "\n".join(
                part for part in (result.stderr.strip(), result.stdout.strip()) if part
            )
            raise RexError(detail or f"Codex exited with status {result.returncode}")
        response = output_path.read_text(encoding="utf-8").strip()
        if not response:
            raise RexError("Codex completed without a final Rex response")
        resolved_id = session_id or parse_thread_id(result.stdout)
        if not resolved_id:
            raise RexError("Codex did not report a thread ID")
        return resolved_id, response
    finally:
        output_path.unlink(missing_ok=True)


def ask(
    prompt: str,
    state_dir: Path,
    repo_root: Path,
    codex_binary: str,
    lock_timeout: float,
) -> str:
    lock_handle = acquire_lock(state_dir, lock_timeout)
    try:
        session_id = read_session_id(state_dir)
        request = prompt if session_id else bootstrap_prompt(repo_root, prompt)
        try:
            resolved_id, response = invoke_codex(
                request, session_id, state_dir, repo_root, codex_binary
            )
        except RexError as error:
            if session_id and is_unresumable_session(str(error)):
                clear_session_id(state_dir)
                resolved_id, response = invoke_codex(
                    bootstrap_prompt(repo_root, prompt),
                    None,
                    state_dir,
                    repo_root,
                    codex_binary,
                )
            else:
                raise
        write_session_id(state_dir, resolved_id)
        return response
    finally:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        lock_handle.close()


def mcp_response(request_id: object, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve_mcp(input_stream: TextIO, output_stream: TextIO) -> int:
    """Serve the narrow ask_rex tool over newline-delimited MCP JSON-RPC."""

    def send(payload: dict) -> None:
        output_stream.write(json.dumps(payload, separators=(",", ":")) + "\n")
        output_stream.flush()

    for raw_line in input_stream:
        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        request_id = request.get("id")
        method = request.get("method")
        if method == "initialize":
            requested_version = request.get("params", {}).get(
                "protocolVersion", "2024-11-05"
            )
            send(
                mcp_response(
                    request_id,
                    {
                        "protocolVersion": requested_version,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "rex", "version": "0.1.0"},
                    },
                )
            )
        elif method == "tools/list":
            send(
                mcp_response(
                    request_id,
                    {
                        "tools": [
                            {
                                "name": "ask_rex",
                                "description": (
                                    "Send a message verbatim to the single persistent "
                                    "Rex agent and return Rex's response"
                                ),
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "prompt": {
                                            "type": "string",
                                            "description": "Message to send to Rex",
                                            "minLength": 1,
                                        }
                                    },
                                    "required": ["prompt"],
                                    "additionalProperties": False,
                                },
                            }
                        ]
                    },
                )
            )
        elif method == "tools/call":
            params = request.get("params", {})
            arguments = params.get("arguments", {})
            prompt = arguments.get("prompt")
            if params.get("name") != "ask_rex" or not isinstance(prompt, str):
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32602, "message": "Invalid ask_rex call"},
                    }
                )
                continue
            try:
                response = ask(
                    prompt=prompt,
                    state_dir=default_state_dir(),
                    repo_root=Path(
                        os.environ.get("REX_REPO_ROOT", str(default_repo_root()))
                    ).expanduser(),
                    codex_binary=os.environ.get("REX_CODEX_BIN", "codex"),
                    lock_timeout=float(os.environ.get("REX_LOCK_TIMEOUT", "300")),
                )
                send(
                    mcp_response(
                        request_id,
                        {
                            "content": [{"type": "text", "text": response}],
                            "structuredContent": {"content": response},
                            "isError": False,
                        },
                    )
                )
            except (OSError, RexError, ValueError) as error:
                send(
                    mcp_response(
                        request_id,
                        {
                            "content": [{"type": "text", "text": str(error)}],
                            "isError": True,
                        },
                    )
                )
        elif request_id is not None:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": "Method not found"},
                }
            )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rex", description="Ask the single persistent Rex agent"
    )
    subparsers = parser.add_subparsers(dest="command")
    ask_parser = subparsers.add_parser("ask", help="send Rex a request")
    ask_parser.add_argument("prompt", nargs="+", help="request to send")
    subparsers.add_parser("status", help="show the persistent Rex session ID")
    subparsers.add_parser("mcp-server", help="serve ask_rex over MCP stdio")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    state_dir = default_state_dir()
    try:
        if args.command == "status":
            session_id = read_session_id(state_dir)
            if session_id:
                print(f"Rex session: {session_id}")
                print(f"State: {state_path(state_dir)}")
                return 0
            print("Rex has not been started yet.")
            return 1
        if args.command == "mcp-server":
            return serve_mcp(sys.stdin, sys.stdout)
        if args.command != "ask":
            parser.print_help(sys.stderr)
            return 2
        response = ask(
            prompt=" ".join(args.prompt),
            state_dir=state_dir,
            repo_root=Path(
                os.environ.get("REX_REPO_ROOT", str(default_repo_root()))
            ).expanduser(),
            codex_binary=os.environ.get("REX_CODEX_BIN", "codex"),
            lock_timeout=float(os.environ.get("REX_LOCK_TIMEOUT", "300")),
        )
        print(response)
        return 0
    except (OSError, RexError, ValueError) as error:
        print(f"rex: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
