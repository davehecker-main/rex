#!/usr/bin/env python3
"""Guarded checkout/check-in commands for Rex's staging-first workflow."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

PROTECTED_BRANCHES = {"main", "staging"}
ISSUE_PATTERN = re.compile(
    r"https://github\.com/ShareViewLLC/ShareView/issues/(?P<number>\d+)"
)


class WorkflowError(RuntimeError):
    pass


def run(*args: str, cwd: Path | None = None, capture: bool = False) -> str:
    result = subprocess.run(
        args, cwd=cwd, check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def current_branch(cwd: Path) -> str:
    return run("git", "branch", "--show-current", cwd=cwd, capture=True)


def require_feature_branch(cwd: Path) -> str:
    branch = current_branch(cwd)
    if not branch or branch in PROTECTED_BRANCHES:
        raise WorkflowError("Refusing to operate on main, staging, or detached HEAD")
    return branch


def validate_branch_name(branch: str) -> None:
    if branch in PROTECTED_BRANCHES:
        raise WorkflowError("Feature branch cannot be main or staging")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", branch):
        raise WorkflowError("Invalid feature branch name")


def checkout(branch: str, destination: Path | None, cwd: Path) -> None:
    validate_branch_name(branch)
    repo_root = Path(run("git", "rev-parse", "--show-toplevel", cwd=cwd, capture=True))
    target = destination or repo_root.parent / "rex-worktrees" / branch.replace("/", "-")
    run("git", "fetch", "origin", "staging", cwd=repo_root)
    run("git", "worktree", "add", "-b", branch, str(target), "origin/staging", cwd=repo_root)
    print(target)


def pr_body(issue: int, verification: str) -> str:
    return f"""## What changed

See the commit diff for this scoped Rex change.

Closes https://github.com/ShareViewLLC/ShareView/issues/{issue}

## How it was verified

{verification}

## Future Improvements

None identified.
"""


def checkin(issue: int, message: str, verification: str, paths: list[str], cwd: Path) -> None:
    branch = require_feature_branch(cwd)
    if issue < 1:
        raise WorkflowError("ShareView issue number must be positive")
    if not paths:
        raise WorkflowError("Check-in requires explicit file paths")
    if not verification.strip():
        raise WorkflowError("Verification evidence cannot be empty")
    already_staged = run(
        "git", "diff", "--cached", "--name-only", cwd=cwd, capture=True
    )
    if already_staged:
        raise WorkflowError("Refusing check-in with pre-existing staged changes")
    run("git", "add", "--", *paths, cwd=cwd)
    staged = run("git", "diff", "--cached", "--name-only", cwd=cwd, capture=True)
    if not staged:
        raise WorkflowError("The named paths contain no staged changes")
    run("git", "commit", "-m", message, cwd=cwd)
    run("git", "push", "-u", "origin", branch, cwd=cwd)
    run(
        "gh", "pr", "create", "--draft", "--base", "staging", "--head", branch,
        "--title", message, "--body", pr_body(issue, verification), cwd=cwd,
    )


def validate_pr(base: str, head: str, body: str) -> None:
    if base == "main":
        if head != "staging":
            raise WorkflowError("Only staging may target main")
        return
    if base != "staging":
        raise WorkflowError("Rex pull requests must target staging or main")
    if head in PROTECTED_BRANCHES:
        raise WorkflowError("A staging PR must come from a feature branch")
    if not ISSUE_PATTERN.search(body):
        raise WorkflowError("A staging PR must link a ShareView issue")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    begin = commands.add_parser("checkout")
    begin.add_argument("branch")
    begin.add_argument("--path", type=Path)
    finish = commands.add_parser("checkin")
    finish.add_argument("--issue", type=int, required=True)
    finish.add_argument("--message", required=True)
    finish.add_argument("--verification", required=True)
    finish.add_argument("paths", nargs="+")
    policy = commands.add_parser("validate-pr")
    policy.add_argument("--base", required=True)
    policy.add_argument("--head", required=True)
    policy.add_argument("--body", default="")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        cwd = Path.cwd()
        if args.command == "checkout":
            checkout(args.branch, args.path, cwd)
        elif args.command == "checkin":
            checkin(args.issue, args.message, args.verification, args.paths, cwd)
        else:
            validate_pr(args.base, args.head, args.body)
    except (WorkflowError, subprocess.CalledProcessError) as error:
        print(f"rex-workflow: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
