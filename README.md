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
docs/charter.md             mission and scope
docs/constitution.md        fixed principles
docs/operating-model.md     how work runs
```

## Status

Sprint 0. The foundation documents exist; nothing is automated yet. What Rex
deliberately has not decided is listed at the end of `docs/operating-model.md`.
