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

When a dedicated GitHub credential is available, the wrapper also gives Rex read-only
access to GitHub issues and pull requests through GitHub's official remote MCP server.
On macOS it reads the credential from the `com.davidhecker.rex.github-read` Keychain
item for account `rex`. Use a fine-grained token restricted to
`ShareViewLLC/ShareView` with read-only Metadata, Issues, and Pull requests permissions.
The wrapper ignores the user's global Codex configuration and sends MCP traffic through
a loopback proxy that holds the credential outside the Codex process. The proxy exposes
only issue and pull-request read/list/search tools and enables GitHub's read-only mode.
The token is unavailable to model-run shell commands and never appears in command-line
arguments or telemetry. Without that dedicated token, GitHub access is not configured
and Rex continues to work locally.
