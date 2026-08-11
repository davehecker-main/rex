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
```

## Status

Sprint 0. The foundation documents exist; nothing is automated yet. What Rex
deliberately has not decided is listed at the end of `docs/operating-model.md`.

## Persistent Rex

Rex is one persistent Codex conversation reached through an on-demand local wrapper.
The process does not run continuously: each call resumes the same Codex session,
returns Rex's response, and exits. A global lock prevents multiple clients from
writing the session at once.

The Codex session provides conversational continuity; this repository remains Rex's
authoritative long-term memory. Claude Code, ChatGPT Desktop, and future clients are
interfaces into Rex rather than separate Rex instances. See `docs/architecture.md`.

Ask Rex locally:

```bash
./bin/rex ask "What should I work on next?"
./bin/rex status
./bin/rex mcp-server
```

Rex starts in a read-only sandbox. It can inspect, advise, review, and propose; changes
still require a separately authorized implementation workflow.
