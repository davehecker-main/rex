# Rex

Rex is a personal AI engineering operating system: the written rules, practices, and
working agreements that let one engineer use Claude Code to build and continuously
improve high-quality software.

Rex is not a product, a framework, or a tool to install. It is a repository of
decisions. The value is that the decisions are written down, versioned, and applied
consistently instead of being re-derived in every session.

## Read these first

| Doc | What it owns |
|---|---|
| `docs/charter.md` | Mission, primary user, what is in and out of scope, what success means |
| `docs/constitution.md` | The principles that do not change session to session, and what each one forbids |
| `docs/operating-model.md` | How work actually runs: the unit of work, the human/agent split, what "done" means |
| `docs/architecture.md` | How clients reach one persistent, on-demand Rex agent |
| `docs/workflow.md` | Mandatory checkout, check-in, staging, and release rules |
| `docs/personality.md` | Rex's temperament, voice, humor, and communication style |

Read the charter for *why Rex exists*, the constitution for *what Rex will not do*,
and the operating model for *how a change gets made*.

## The repository is the source of truth

A decision that lives only in a chat transcript is not a decision — it is a thing that
gets argued again next week. If it matters, it is committed here.

When a doc disagrees with anyone's recollection of how something went last time, the
doc wins. Changing a rule means changing the doc, in its own commit, on purpose.

## Layout

```
README.md                   this file — the entry point
bin/rex                     on-demand Rex command
src/rex_cli.py              persistent-session wrapper
docs/architecture.md        persistent Rex architecture
docs/charter.md             mission and scope
docs/constitution.md        fixed principles
docs/operating-model.md     how work runs
docs/workflow.md            Git and GitHub workflow
docs/personality.md         personality and communication style
AGENTS.md                   instructions loaded by coding agents
bin/rex-workflow            guarded checkout/check-in command
```

## Status

The first working version is implemented. `bin/rex` and `src/rex_cli.py` provide the
on-demand wrapper; the test suite covers initial bootstrap, session persistence,
serialized access, MCP exposure, recovery when Codex reports that a stored session no
longer exists, and per-invocation telemetry. ShareView is the first configured client:
its Claude Code `/rex` command reaches the wrapper through the narrow `ask_rex` MCP
tool. Rex's Git and GitHub workflow is automated where the repository's GitHub plan
permits.

What Rex deliberately has not decided remains listed at the end of
`docs/operating-model.md`.

## Persistent Rex

Rex is one persistent Codex conversation reached through an on-demand local wrapper.
The process does not run continuously: each call resumes the same Codex session,
returns Rex's response, and exits. A global lock prevents multiple clients from
writing the session at once.

The Codex session provides conversational continuity; this repository remains Rex's
authoritative long-term memory. Claude Code, ChatGPT Desktop, and future clients are
interfaces into Rex rather than separate Rex instances. See `docs/architecture.md`.

Use Rex from this checkout:

```bash
./bin/rex ask "What should I work on next?"
./bin/rex status
./bin/rex mcp-server
```

`ask` is the interactive CLI path. Agent clients start `mcp-server` and call its
`ask_rex` tool.

The wrapper expects `bin/rex` and `src/rex_cli.py` to retain their repository-relative
layout. For ShareView, set `REX_BIN` to the absolute path of this checkout's `bin/rex`,
or provide a complete `rex` installation on `PATH`. Copying `bin/rex` by itself is not
an installation: it resolves `../src/rex_cli.py` relative to its own location.

Rex starts in a read-only sandbox. It can inspect, advise, review, and propose; changes
still require a separately authorized implementation workflow.

When the dedicated `dr-rex-phd` GitHub credential is available, the wrapper gives Rex
read access to GitHub issues and pull requests plus the ability to comment on ShareView
issues. Pull-request comments and every other mutation remain unavailable.
On macOS it reads the credential from the `com.davidhecker.rex.github-read` Keychain
item for account `rex`. Use a fine-grained token restricted to
`ShareViewLLC/ShareView` with Metadata read, Pull requests read, and Issues read/write.
The wrapper ignores the user's global Codex configuration and sends MCP traffic through
a loopback proxy that holds the credential outside the Codex process. The proxy exposes
only issue and pull-request read/list/search tools plus a fixed issue-comment tool. The
comment path resolves a typed Issue before mutation, so it rejects pull requests.
The token is unavailable to model-run shell commands and never appears in command-line
arguments or telemetry. Without that dedicated token, GitHub access is not configured
and Rex continues to work locally.

Issue creation is a separate, one-use capability available only from a direct local
invocation:

```bash
rex ask --allow-shareview-issue-create "Create the issue we discussed"
```

The flag exposes one fixed ShareView issue-creation tool for that invocation and is not
available through `rex mcp-server`. Every created issue receives the `rex` label; the
model cannot omit or replace it. Every attempted mutation is recorded in the
permission-restricted Rex state directory without storing the token or request body.

For a deterministic, explicitly authorized creation that does not place Codex in the
write path, use:

```bash
rex create-shareview-issue --title "Title" --body "Body"
```

This command verifies the dedicated identity, creates exactly one issue with the fixed
`rex` label, reads the created issue back to verify that label, and uses the same
append-only mutation audit. It accepts no repository, owner, labels, or arbitrary
request payload. A failed verification reports the created issue URL and never retries
the creation.

An explicitly authorized issue comment uses the same deterministic boundary:

```bash
rex comment-shareview-issue 123 --body "Comment"
```

The wrapper resolves the number through GitHub's typed Issue field, so a pull request
with the same number is rejected. The command accepts no repository, URL, or arbitrary
GraphQL payload and uses the same append-only mutation audit.
