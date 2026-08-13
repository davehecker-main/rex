#!/usr/bin/env python3
"""On-demand entrypoint for the single persistent Rex Codex session."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import http.server
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import TextIO


STATE_VERSION = 1
INVOCATION_RECORD_VERSION = 2
TOKEN_USAGE_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
)
GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
GITHUB_KEYCHAIN_ACCOUNT = "rex"
GITHUB_KEYCHAIN_SERVICE = "com.davidhecker.rex.github-read"
GITHUB_EXPECTED_LOGIN = "dr-rex-phd"
GITHUB_EXPECTED_USER_ID = 316333787
GITHUB_OWNER = "ShareViewLLC"
GITHUB_REPOSITORY = "ShareView"
GITHUB_READ_TOOLS = (
    "issue_read",
    "list_issues",
    "search_issues",
    "pull_request_read",
    "list_pull_requests",
    "search_pull_requests",
)
GITHUB_COMMENT_TOOL = "comment_on_shareview_issue"
GITHUB_CREATE_TOOL = "create_shareview_issue"

# The two phrasings `codex exec resume` has actually been observed producing for a
# session it cannot resume. Both are measured, not guessed: "session not found for
# thread_id", and "no rollout found for thread id <id> (code -32600)" once the
# rollout has been pruned.
#
# Deliberately not a wider list. A false positive here is worse than the bug this
# recovers from: it discards a live session and silently hands the caller a Rex with
# no memory. A phrase only plausibly emitted is not evidence, so it does not belong.
UNRESUMABLE_SESSION_MARKERS = (
    "session not found",
    "no rollout found",
)


class RexError(RuntimeError):
    """An expected Rex invocation failure.

    `kind` is set at the raise site rather than derived from the message. Reading a
    category back out of human-readable text is the mistake that cost a live session
    once already; telemetry classifies failures off this field alone.
    """

    def __init__(
        self,
        message: str,
        *,
        stderr: str = "",
        kind: str | None = None,
        usage: dict[str, int] | None = None,
    ) -> None:
        super().__init__(message)
        self.stderr = stderr
        self.kind = kind
        self.usage = usage


class GitHubMutationPostconditionError(RexError):
    """The mutation happened, but its required postcondition did not verify."""

    def __init__(
        self, message: str, *, url: str, number: int, request_id: str | None, kind: str
    ) -> None:
        super().__init__(message, kind=kind)
        self.url = url
        self.number = number
        self.request_id = request_id


class OneUseGrant:
    def __init__(self, enabled: bool = False) -> None:
        self._available = enabled
        self._lock = threading.Lock()

    def available(self) -> bool:
        with self._lock:
            return self._available

    def consume(self) -> bool:
        with self._lock:
            if not self._available:
                return False
            self._available = False
            return True


def is_unresumable_session(error: BaseException) -> bool:
    """True when Codex's diagnostics say the stored session no longer exists.

    Reads Codex's stderr alone. The combined stderr+stdout blob carried in the
    exception message also holds `--json` event output, which is model-influenced
    text: a marker appearing inside a Rex response would otherwise be read as a
    transport diagnostic and cost a live session.
    """
    lowered = getattr(error, "stderr", "").lower()
    return any(marker in lowered for marker in UNRESUMABLE_SESSION_MARKERS)


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_state_dir() -> Path:
    override = os.environ.get("REX_STATE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Application Support" / "Rex"


def read_github_token() -> str | None:
    """Read Rex's dedicated GitHub credential without putting it in arguments."""
    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                GITHUB_KEYCHAIN_ACCOUNT,
                "-s",
                GITHUB_KEYCHAIN_SERVICE,
                "-w",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def github_mcp_headers(incoming, token: str) -> dict[str, str]:
    """Replace every caller-controlled GitHub MCP policy header."""
    headers = {
        key: value
        for key, value in incoming.items()
        if key.lower()
        not in {"authorization", "connection", "host", "content-length"}
        and not key.lower().startswith("x-mcp-")
    }
    headers["Authorization"] = f"Bearer {token}"
    headers["X-MCP-Tools"] = ",".join(GITHUB_READ_TOOLS)
    headers["X-MCP-Readonly"] = "true"
    return headers


def github_api(token: str, method: str, path: str, payload: dict | None = None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "rex-github-boundary",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPSConnection("api.github.com", timeout=60)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        data = json.loads(raw) if raw else None
        if response.status < 200 or response.status >= 300:
            raise RexError(
                f"GitHub request failed ({response.status}): "
                f"{data.get('message', 'unknown error') if isinstance(data, dict) else 'unknown error'}",
                kind="github_error",
            )
        return data, response.getheader("X-GitHub-Request-Id")
    finally:
        connection.close()


def verify_github_identity(token: str) -> dict:
    identity, _ = github_api(token, "GET", "/user")
    if (
        not isinstance(identity, dict)
        or str(identity.get("login", "")).lower() != GITHUB_EXPECTED_LOGIN
        or identity.get("id") != GITHUB_EXPECTED_USER_ID
    ):
        raise RexError(
            f"Rex GitHub credential is not {GITHUB_EXPECTED_LOGIN}",
            kind="github_identity_error",
        )
    return identity


def mutation_audit_path(state_dir: Path) -> Path:
    return state_dir / "github-mutations.jsonl"


def audit_mutation(state_dir: Path, record: dict) -> None:
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = mutation_audit_path(state_dir)
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")


def mutation_error_outcome(error: Exception) -> str:
    if isinstance(error, RexError) and error.kind == "github_policy_error":
        return "denied"
    if isinstance(error, RexError) and error.kind == "github_error":
        return "failed"
    return "unknown"


def custom_tool_definitions(allow_issue_create: bool) -> list[dict]:
    tools = [
        {
            "name": GITHUB_COMMENT_TOOL,
            "description": "Add a comment to an existing ShareView issue; pull requests are rejected",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_number": {"type": "integer", "minimum": 1},
                    "body": {"type": "string", "minLength": 1},
                },
                "required": ["issue_number", "body"],
                "additionalProperties": False,
            },
        }
    ]
    if allow_issue_create:
        tools.append(
            {
                "name": GITHUB_CREATE_TOOL,
                "description": "Create one ShareView issue for this explicitly authorized invocation",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "minLength": 1},
                        "body": {"type": "string"},
                    },
                    "required": ["title", "body"],
                    "additionalProperties": False,
                },
            }
        )
    return tools


def augment_tool_list(payload: bytes, allow_issue_create: bool) -> bytes:
    additions = custom_tool_definitions(allow_issue_create)

    def augment(document: dict) -> dict:
        document.get("result", {}).setdefault("tools", []).extend(additions)
        return document

    try:
        return json.dumps(augment(json.loads(payload))).encode()
    except (json.JSONDecodeError, UnicodeDecodeError):
        lines = payload.decode().splitlines()
        changed = False
        for index, line in enumerate(lines):
            if not line.startswith("data:"):
                continue
            try:
                document = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(document, dict) and "result" in document:
                lines[index] = "data: " + json.dumps(augment(document), separators=(",", ":"))
                changed = True
        if not changed:
            raise RexError("GitHub MCP returned an unreadable tool list", kind="github_error")
        return ("\n".join(lines) + "\n").encode()


def mutation_result(token: str, name: str, arguments: dict, create_grant: OneUseGrant):
    if name == GITHUB_COMMENT_TOOL:
        number = arguments.get("issue_number")
        body = arguments.get("body")
        if not isinstance(number, int) or number < 1 or not isinstance(body, str) or not body:
            raise RexError("Invalid issue comment arguments", kind="github_policy_error")
        issue, _ = github_api(
            token,
            "POST",
            "/graphql",
            {"query": "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id url}}}", "variables": {"owner": GITHUB_OWNER, "repo": GITHUB_REPOSITORY, "number": number}},
        )
        target = issue.get("data", {}).get("repository", {}).get("issue")
        if not target:
            raise RexError("Target is not a ShareView issue", kind="github_policy_error")
        result, request_id = github_api(
            token,
            "POST",
            "/graphql",
            {"query": "mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{id url}}}}", "variables": {"id": target["id"], "body": body}},
        )
        node = result["data"]["addComment"]["commentEdge"]["node"]
        return node, request_id, number, body
    if name == GITHUB_CREATE_TOOL:
        if not create_grant.consume():
            raise RexError("Issue creation is not authorized for this invocation", kind="github_policy_error")
        title, body = arguments.get("title"), arguments.get("body")
        if not isinstance(title, str) or not title or not isinstance(body, str):
            raise RexError("Invalid issue creation arguments", kind="github_policy_error")
        result, request_id = github_api(
            token,
            "POST",
            f"/repos/{GITHUB_OWNER}/{GITHUB_REPOSITORY}/issues",
            {"title": title, "body": body, "labels": ["rex"]},
        )
        number, url = result["number"], result["html_url"]
        try:
            verified, _ = github_api(
                token,
                "GET",
                f"/repos/{GITHUB_OWNER}/{GITHUB_REPOSITORY}/issues/{number}",
            )
            if not isinstance(verified, dict) or not isinstance(
                verified.get("labels"), list
            ):
                raise ValueError("GitHub returned malformed issue labels")
            if any(
                not isinstance(label, dict) or not isinstance(label.get("name"), str)
                for label in verified["labels"]
            ):
                raise ValueError("GitHub returned a malformed issue label")
        except Exception as error:
            raise GitHubMutationPostconditionError(
                f"Issue created at {url}, but the required rex label could not be verified: {error}",
                url=url,
                number=number,
                request_id=request_id,
                kind="github_postcondition_unknown",
            ) from error
        labels = {
            label.get("name")
            for label in verified["labels"]
        }
        if "rex" not in labels:
            raise GitHubMutationPostconditionError(
                f"Issue created at {url}, but GitHub did not apply the required rex label",
                url=url,
                number=number,
                request_id=request_id,
                kind="github_postcondition_failed",
            )
        return {"id": result["node_id"], "url": url}, request_id, number, title + "\n" + body
    raise RexError("GitHub mutation tool is not allowed", kind="github_policy_error")


def handle_mutation_call(
    token: str,
    state_dir: Path,
    identity: dict,
    create_grant: OneUseGrant,
    request: dict,
) -> dict:
    params = request.get("params", {})
    name = params.get("name")
    arguments = params.get("arguments", {})
    correlation_id = secrets.token_hex(16)
    record = {
        "correlation_id": correlation_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "login": identity["login"],
        "user_id": identity["id"],
        "operation": name,
        "repository": f"{GITHUB_OWNER}/{GITHUB_REPOSITORY}",
        "authorized_create": create_grant.available(),
        "body_sha256": hashlib.sha256(
            json.dumps(arguments, sort_keys=True).encode()
        ).hexdigest(),
        "outcome": "attempted",
    }
    audit_mutation(state_dir, record)
    try:
        result, request_id, number, content = mutation_result(
            token, name, arguments, create_grant
        )
        record.update(
            {
                "outcome": "success",
                "target_number": number,
                "github_request_id": request_id,
                "result_url": result["url"],
                "content_length": len(content),
            }
        )
        response = {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "content": [{"type": "text", "text": json.dumps(result)}],
                "isError": False,
            },
        }
    except Exception as error:
        record.update({"outcome": mutation_error_outcome(error), "reason": str(error)})
        if isinstance(error, GitHubMutationPostconditionError):
            record.update(
                {
                    "target_number": error.number,
                    "github_request_id": error.request_id,
                    "result_url": error.url,
                    "outcome": (
                        "failed"
                        if error.kind == "github_postcondition_failed"
                        else "unknown"
                    ),
                }
            )
        response = {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "content": [{"type": "text", "text": str(error)}],
                "isError": True,
            },
        }
    finally:
        try:
            audit_mutation(state_dir, record)
        except OSError as audit_error:
            response["result"]["content"].append(
                {
                    "type": "text",
                    "text": (
                        "Audit finalization failed; preliminary record "
                        f"{correlation_id} remains unresolved: {audit_error}"
                    ),
                }
            )
    return response


def create_shareview_issue_direct(title: str, body: str, state_dir: Path) -> dict:
    """Create one fixed-policy ShareView issue without placing Codex in the write path."""
    token = read_github_token()
    if not token:
        raise RexError("Rex GitHub credential is not configured", kind="github_identity_error")
    identity = verify_github_identity(token)
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "params": {
            "name": GITHUB_CREATE_TOOL,
            "arguments": {"title": title, "body": body},
        },
    }
    response = handle_mutation_call(
        token, state_dir, identity, OneUseGrant(True), request
    )
    result = response.get("result", {})
    content = result.get("content", [])
    if result.get("isError") or not content:
        detail = content[0].get("text") if content else "Issue creation failed"
        raise RexError(detail, kind="github_error")
    try:
        created = json.loads(content[0]["text"])
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise RexError(
            "GitHub issue creation returned an unreadable result", kind="github_error"
        ) from error
    if not isinstance(created, dict) or not isinstance(created.get("url"), str):
        raise RexError(
            "GitHub issue creation returned an incomplete result", kind="github_error"
        )
    if len(content) > 1:
        warnings = "; ".join(
            item.get("text", "unknown warning")
            for item in content[1:]
            if isinstance(item, dict)
        )
        raise RexError(
            f"Issue created at {created['url']}, but completion is unresolved: {warnings}",
            kind="github_audit_error",
        )
    return created


def comment_shareview_issue_direct(
    issue_number: int, body: str, state_dir: Path
) -> dict:
    """Comment on one typed ShareView issue without placing Codex in the write path."""
    token = read_github_token()
    if not token:
        raise RexError("Rex GitHub credential is not configured", kind="github_identity_error")
    identity = verify_github_identity(token)
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "params": {
            "name": GITHUB_COMMENT_TOOL,
            "arguments": {"issue_number": issue_number, "body": body},
        },
    }
    response = handle_mutation_call(
        token, state_dir, identity, OneUseGrant(False), request
    )
    result = response.get("result", {})
    content = result.get("content", [])
    if result.get("isError") or not content:
        detail = content[0].get("text") if content else "Issue comment failed"
        raise RexError(detail, kind="github_error")
    try:
        comment = json.loads(content[0]["text"])
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise RexError(
            "GitHub issue comment returned an unreadable result", kind="github_error"
        ) from error
    if not isinstance(comment, dict) or not isinstance(comment.get("url"), str):
        raise RexError(
            "GitHub issue comment returned an incomplete result", kind="github_error"
        )
    if len(content) > 1:
        warnings = "; ".join(
            item.get("text", "unknown warning")
            for item in content[1:]
            if isinstance(item, dict)
        )
        raise RexError(
            f"Comment created at {comment['url']}, but completion is unresolved: {warnings}",
            kind="github_audit_error",
        )
    return comment


@contextmanager
def github_mcp_proxy(token: str, state_dir: Path, create_grant: OneUseGrant):
    """Keep the GitHub credential outside the Codex process and its shell tools."""
    class ProxyHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self._forward()

        def do_GET(self):
            self._forward()

        def do_DELETE(self):
            self._forward()

        def log_message(self, _format, *args):
            return

        def _forward(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else None
            request = json.loads(body) if body else None
            if isinstance(request, dict) and request.get("method") == "tools/call":
                params = request.get("params", {})
                name = params.get("name")
                if name in {GITHUB_COMMENT_TOOL, GITHUB_CREATE_TOOL}:
                    response_payload = handle_mutation_call(
                        token, state_dir, identity, create_grant, request
                    )
                    encoded = json.dumps(response_payload).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                    return
            headers = github_mcp_headers(self.headers, token)
            connection = http.client.HTTPSConnection("api.githubcopilot.com", timeout=60)
            try:
                connection.request(self.command, "/mcp/", body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read()
                if isinstance(request, dict) and request.get("method") == "tools/list" and response.status == 200:
                    payload = augment_tool_list(payload, create_grant.available())
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in {
                        "connection",
                        "content-length",
                        "transfer-encoding",
                    }:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            finally:
                connection.close()

    class QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
        def handle_error(self, _request, _client_address):
            return

    identity = verify_github_identity(token)
    server = QuietThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}/mcp/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def state_path(state_dir: Path) -> Path:
    return state_dir / "state.json"


def read_session_id(state_dir: Path) -> str | None:
    path = state_path(state_dir)
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RexError(
            f"Cannot read Rex state at {path}: {error}", kind="state_error"
        ) from error
    if state.get("version") != STATE_VERSION:
        raise RexError(f"Unsupported Rex state version in {path}", kind="state_error")
    session_id = state.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise RexError(
            f"Rex state at {path} has no valid session_id", kind="state_error"
        )
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
                    f"Rex is busy; timed out after {timeout_seconds:g} seconds",
                    kind="lock_timeout",
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


def parse_token_usage(json_lines: str) -> dict[str, int] | None:
    """Total Codex's reported token usage across a stream of `--json` events.

    Every value here is model-adjacent output, so nothing is trusted by shape alone:
    malformed lines, unrelated events, booleans, negatives and non-integers are all
    dropped rather than coerced. Returns None when Codex reported no usable usage at
    all - which is a different fact from Codex reporting zero, and is recorded as a
    different value.
    """
    totals: dict[str, int] = {}
    for line in json_lines.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "turn.completed":
            continue
        usage = event.get("usage")
        if not isinstance(usage, dict):
            continue
        for field in TOKEN_USAGE_FIELDS:
            value = usage.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                continue
            totals[field] = totals.get(field, 0) + value
    return totals or None


def usage_baseline_path(state_dir: Path) -> Path:
    return state_dir / "usage.json"


def read_usage_baseline(state_dir: Path, session_id: str | None) -> dict[str, int] | None:
    """The cumulative totals this session had reached at the end of the last call.

    Returns None when the baseline is unknown - absent, unreadable, or belonging to a
    different session. Unknown is recorded as null rather than guessed, because a
    wrong delta is worse than a missing one.

    Deliberately a separate file. Adding a field to `state.json` would need
    STATE_VERSION bumped, and `read_session_id` fails closed on an unrecognised
    version - which would take every existing Rex session down on upgrade.
    """
    if not session_id:
        return None
    path = usage_baseline_path(state_dir)
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(stored, dict) or stored.get("session_id") != session_id:
        return None
    totals = stored.get("totals")
    if not isinstance(totals, dict):
        return None
    return {
        field: value
        for field, value in totals.items()
        if field in TOKEN_USAGE_FIELDS
        and isinstance(value, int)
        and not isinstance(value, bool)
        and value >= 0
    }


def write_usage_baseline(
    state_dir: Path, session_id: str, totals: dict[str, int] | None
) -> None:
    if not totals:
        return
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = json.dumps(
        {"session_id": session_id, "totals": totals}, sort_keys=True
    ) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        dir=state_dir, prefix="usage.", suffix=".tmp", text=True
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, usage_baseline_path(state_dir))
    finally:
        temporary_path.unlink(missing_ok=True)


def invocation_log_path(state_dir: Path) -> Path:
    return state_dir / "invocations.jsonl"


def append_invocation_record(state_dir: Path, record: dict) -> None:
    """Append one telemetry line, 0600, never touching state.json.

    `state.json` is atomically replaced on every write and has a different lifecycle;
    mixing an append-only log into it would make one of the two wrong.
    """
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = invocation_log_path(state_dir)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        # An existing file created under a permissive umask keeps its old mode, so
        # set it explicitly rather than relying on the open() mode argument.
        os.fchmod(descriptor, 0o600)
        payload = json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
        os.write(descriptor, payload.encode("utf-8"))
    finally:
        os.close(descriptor)


class InvocationTelemetry:
    """Facts about one `ask()` call, accumulated as it runs.

    Codex reports token usage as a running total for the whole session, not for the
    turn. So the last attempt's numbers replace earlier ones rather than adding to
    them: summing two attempts would double-count a resume that failed, and summing
    across a recovery adds the dead session's lifetime total to the new session's.
    """

    def __init__(self) -> None:
        self.started_at = datetime.now(timezone.utc)
        self.started_monotonic = time.monotonic()
        self.started_with_session = False
        self.attempts = 0
        self.recovery_attempted = False
        self.recovery_succeeded = False
        self.session_usage: dict[str, int] | None = None
        # Cumulative totals this session had already reached before this call.
        # None means unknown; zero means the session began in this call.
        self.usage_baseline: dict[str, int] | None = None

    def observe_usage(self, usage: dict[str, int] | None) -> None:
        if usage:
            self.session_usage = dict(usage)

    def begin_attempt(self, baseline: dict[str, int] | None) -> None:
        self.attempts += 1
        self.usage_baseline = baseline
        self.session_usage = None

    def record(self, *, success: bool, failure_kind: str | None) -> dict:
        usage = self.session_usage or {}
        baseline = self.usage_baseline
        record = {
            "version": INVOCATION_RECORD_VERSION,
            "started_at": self.started_at.isoformat().replace("+00:00", "Z"),
            "duration_seconds": round(
                time.monotonic() - self.started_monotonic, 3
            ),
            "success": success,
            "started_with_session": self.started_with_session,
            "attempts": self.attempts,
            "recovery_attempted": self.recovery_attempted,
            "recovery_succeeded": self.recovery_succeeded,
            # No dollar figure. The wrapper knows no authoritative price, billing
            # mode, or subscription allocation, and a number derived from public
            # pricing would read as measured when it was guessed.
            "cost_usd": None,
            "failure_kind": failure_kind,
        }
        for field in TOKEN_USAGE_FIELDS:
            total = usage.get(field)
            record[f"session_{field}"] = total
            if total is None or baseline is None:
                record[f"call_{field}"] = None
            else:
                record[f"call_{field}"] = max(total - baseline.get(field, 0), 0)
        return record


def failure_kind_of(error: BaseException) -> str:
    kind = getattr(error, "kind", None)
    return kind if isinstance(kind, str) and kind else "codex_error"


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
    github_mcp_url: str | None = None,
) -> list[str]:
    command = [
        codex_binary,
        "exec",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--cd",
        str(repo_root),
        "--json",
        "--output-last-message",
        str(output_path),
    ]
    if github_mcp_url:
        tools = ",".join(GITHUB_READ_TOOLS)
        command.extend(
            [
                "--config",
                f'mcp_servers.rex_github.url="{github_mcp_url}"',
                "--config",
                (
                    "mcp_servers.rex_github.http_headers="
                    f'{{"X-MCP-Tools"="{tools}","X-MCP-Readonly"="true"}}'
                ),
            ]
        )
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
    create_grant: OneUseGrant | None = None,
) -> tuple[str, str, dict[str, int] | None]:
    descriptor, output_name = tempfile.mkstemp(
        dir=state_dir, prefix="response.", suffix=".txt", text=True
    )
    os.close(descriptor)
    output_path = Path(output_name)
    try:
        github_token = read_github_token()
        proxy_context = (
            github_mcp_proxy(github_token, state_dir, create_grant or OneUseGrant())
            if github_token
            else nullcontext(None)
        )
        with proxy_context as github_mcp_url:
            result = subprocess.run(
                codex_command(
                    codex_binary,
                    repo_root,
                    output_path,
                    session_id,
                    github_mcp_url=github_mcp_url,
                ),
                input=prompt,
                text=True,
                capture_output=True,
                check=False,
            )
        # Parsed before the exit status is checked. A resume that fails still burned
        # tokens, and a call that recovers should report what both attempts cost
        # rather than only the one that worked.
        usage = parse_token_usage(result.stdout)
        if result.returncode != 0:
            detail = "\n".join(
                part for part in (result.stderr.strip(), result.stdout.strip()) if part
            )
            raise RexError(
                detail or f"Codex exited with status {result.returncode}",
                stderr=result.stderr,
                kind="codex_error",
                usage=usage,
            )
        response = output_path.read_text(encoding="utf-8").strip()
        if not response:
            raise RexError(
                "Codex completed without a final Rex response",
                kind="empty_response",
                usage=usage,
            )
        resolved_id = session_id or parse_thread_id(result.stdout)
        if not resolved_id:
            raise RexError(
                "Codex did not report a thread ID",
                kind="missing_thread_id",
                usage=usage,
            )
        return resolved_id, response, usage
    finally:
        output_path.unlink(missing_ok=True)


def ask_within_lock(
    prompt: str,
    state_dir: Path,
    repo_root: Path,
    codex_binary: str,
    telemetry: InvocationTelemetry,
    create_grant: OneUseGrant | None = None,
) -> str:
    session_id = read_session_id(state_dir)
    telemetry.started_with_session = session_id is not None
    request = prompt if session_id else bootstrap_prompt(repo_root, prompt)
    try:
        # A resume continues a session with a history; a bootstrap starts one at zero.
        telemetry.begin_attempt(
            read_usage_baseline(state_dir, session_id) if session_id else {}
        )
        resolved_id, response, usage = invoke_codex(
            request, session_id, state_dir, repo_root, codex_binary, create_grant
        )
        telemetry.observe_usage(usage)
    except RexError as error:
        telemetry.observe_usage(getattr(error, "usage", None))
        if not (session_id and is_unresumable_session(error)):
            raise
        telemetry.recovery_attempted = True
        clear_session_id(state_dir)
        # The replacement session's counters start at zero, and the dead session's
        # lifetime total is not part of what this call cost.
        telemetry.begin_attempt({})
        try:
            resolved_id, response, usage = invoke_codex(
                bootstrap_prompt(repo_root, prompt),
                None,
                state_dir,
                repo_root,
                codex_binary,
                create_grant,
            )
        except RexError as replacement_error:
            telemetry.observe_usage(getattr(replacement_error, "usage", None))
            raise
        telemetry.observe_usage(usage)
        telemetry.recovery_succeeded = True
    write_session_id(state_dir, resolved_id)
    write_usage_baseline(state_dir, resolved_id, telemetry.session_usage)
    return response


def write_telemetry(
    state_dir: Path,
    record: dict,
    pending_error: BaseException | None = None,
) -> None:
    """Persist one record.

    A telemetry failure must not overwrite a real one, so when the call was already
    failing the write error is reported on stderr and the original exception is left
    to propagate. When the call succeeded, an unwritable record is itself a failure:
    a pilot that cannot record its own measurements should say so rather than return
    a clean answer and quietly measure nothing.
    """
    try:
        append_invocation_record(state_dir, record)
    except OSError as error:
        if pending_error is not None:
            print(f"rex: could not record invocation telemetry: {error}", file=sys.stderr)
            return
        raise RexError(
            f"Rex answered but could not record invocation telemetry: {error}",
            kind="telemetry_error",
        ) from error


def ask(
    prompt: str,
    state_dir: Path,
    repo_root: Path,
    codex_binary: str,
    lock_timeout: float,
    allow_issue_create: bool = False,
) -> str:
    telemetry = InvocationTelemetry()
    create_grant = OneUseGrant(allow_issue_create)
    try:
        lock_handle = acquire_lock(state_dir, lock_timeout)
    except RexError as error:
        # Rejected before Codex ever started: attempts stays 0, and the record is
        # appended without the lock. Append-only writing is what keeps that safe.
        write_telemetry(
            state_dir,
            telemetry.record(success=False, failure_kind=failure_kind_of(error)),
            pending_error=error,
        )
        raise
    try:
        try:
            response = ask_within_lock(
                prompt,
                state_dir,
                repo_root,
                codex_binary,
                telemetry,
                create_grant,
            )
        except BaseException as error:
            write_telemetry(
                state_dir,
                telemetry.record(success=False, failure_kind=failure_kind_of(error)),
                pending_error=error,
            )
            raise
        # Recorded before the lock is released, so a record and the session mutation
        # it describes cannot be interleaved with another caller's.
        write_telemetry(
            state_dir, telemetry.record(success=True, failure_kind=None)
        )
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
    ask_parser.add_argument(
        "--allow-shareview-issue-create",
        action="store_true",
        help="authorize at most one ShareView issue creation for this direct invocation",
    )
    create_parser = subparsers.add_parser(
        "create-shareview-issue",
        help="create one audited ShareView issue through the dedicated Rex identity",
    )
    create_parser.add_argument("--title", required=True, help="issue title")
    create_parser.add_argument("--body", required=True, help="issue body")
    comment_parser = subparsers.add_parser(
        "comment-shareview-issue",
        help="comment on one ShareView issue through the dedicated Rex identity",
    )
    comment_parser.add_argument("issue_number", type=int, help="ShareView issue number")
    comment_parser.add_argument("--body", required=True, help="comment body")
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
        if args.command == "create-shareview-issue":
            created = create_shareview_issue_direct(args.title, args.body, state_dir)
            print(f"Created ShareView issue: {created['url']}")
            return 0
        if args.command == "comment-shareview-issue":
            comment = comment_shareview_issue_direct(
                args.issue_number, args.body, state_dir
            )
            print(f"Commented on ShareView issue: {comment['url']}")
            return 0
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
            allow_issue_create=args.allow_shareview_issue_create,
        )
        print(response)
        return 0
    except (OSError, RexError, ValueError) as error:
        print(f"rex: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
