# Rex Vocabulary

Terms already in use in this repository, defined so they mean the same thing every
time. Definitions here are short on purpose — the document that owns a concept is
named, and owns the detail.

- **Charter** — The document stating why Rex exists, who it serves, and what is in and
  out of scope. `docs/charter.md`.

- **Claude Code** — The coding agent Rex is designed around. It executes inside a
  stated scope, verifies its work, and reports honestly; it does not merge its own
  changes.

- **Constitution** — The principles that hold across sessions, each stating what it
  rules out. `docs/constitution.md`.

- **Draft Pull Request** — The form every change opens in. Opened early, while the
  change can still cheaply change shape — not a formality applied to finished work.

- **Engineer** — The single human Rex is built for. Sets scope, decides tradeoffs, and
  merges. Approval is judgment, not a formality.

- **Engineering Leverage** — Output quality and speed gained per unit of the engineer's
  attention. The measure Rex optimizes: work that raises it is worth doing, work that
  only adds capability is not.

- **Future Improvements** — The PR section where anything found but deliberately not
  built is recorded. It exists to make writing an improvement down cheaper than
  building it, which is what keeps scope from leaking.

- **Operating Model** — How a change actually gets made: unit of work, human/agent
  split, and the definition of done. `docs/operating-model.md`.

- **Playbook** — A repeatable procedure for a recurring engineering situation, written
  once so it is not re-derived each time. Lives in `playbooks/`.

- **Repository** — This Git repository. The canonical statement of what Rex currently
  is; everything else is commentary.

- **Rex** — A personal AI engineering operating system: the written decisions that let
  one engineer use Claude Code to build and improve high-quality software. Rex improves
  the system that produces software, not the product code itself.

- **Scope** — What a change is and is not. A boundary, not a suggestion: work that
  grows past its scope cannot be reviewed, because nobody agreed to review that.

- **Source of Truth** — The rule that a decision counts only when committed. Anything
  living solely in a session transcript is not binding, and when a doc disagrees with
  recollection, the doc wins.

- **Sprint** — A group of related changes that arrive together as a coherent piece of
  the system. A unit of intent, not a schedule.

- **Verification** — Evidence that a change does what it claims: the actual commands
  run and their real output, recorded in the PR. Naming a check is verification;
  asserting that something works is not.
