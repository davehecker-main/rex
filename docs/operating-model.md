# Rex Operating Model

The charter says why Rex exists. The constitution says what Rex will not do. This
document says how a change actually gets made.

It describes the workflow as it runs today, with one engineer and Claude Code. It is
short on purpose: anything written here is something that has to hold every time.

## The unit of work

One scoped change, one branch, one draft pull request.

Work does not begin with a branch and discover its purpose along the way. It begins
with a statement of what is being changed and what is explicitly not — small enough
that the whole diff can be read in one sitting, and self-contained enough that it could
be reverted on its own without taking anything else with it.

Sprints group related changes so a coherent piece of the system arrives together. They
are a unit of intent, not a schedule.

## Where the record lives

In the repository. Specifically:

- **The docs** hold the current rules. They describe what is true now, not the history
  of how it became true.
- **Commit messages** hold why a change was made, for the person reading `git log` in a
  year without the surrounding conversation.
- **Pull request bodies** hold the reasoning around a change: what was done, how it was
  verified, and what was found but deliberately not built.

Nothing important lives only in a session transcript. When a session ends, whatever was
worth keeping is in the repository or it is gone. This is principle 1 as a daily habit
rather than an aspiration.

## Who does what

**The engineer** sets scope, decides tradeoffs, and merges. Approving a change is a
real act of judgment, not a formality performed on work already treated as finished.

**Claude Code** executes inside the stated scope: writes the change, verifies it, and
reports what happened — including what failed, what was skipped, and what is uncertain.
It surfaces decisions rather than absorbing them, and it does not merge its own work.

A clean result reported without its caveats is worse than a messy one reported
accurately, because the first one is trusted.

## Draft pull requests

Every change opens as a **draft** PR, and it opens early — a draft is where a change is
reviewed while it can still cheaply change shape, not a formality applied to finished
work.

Each PR body carries:

- **What changed** — the substance, in enough detail to review without reading every line.
- **How it was verified** — the actual commands run and their real results. Naming a
  check is evidence; asserting that things work is not.
- **Future Improvements** — everything noticed along the way that was deliberately not
  built.

## Future Improvements

Working on a system produces observations about it. Most of them are correct and worth
acting on eventually. Acting on them immediately is how a scoped change stops being one.

So they get written down in the PR that discovered them, with enough context to be
actionable later, and then left alone. That section is the mechanism behind constitution
principle 7: it makes recording an improvement cheaper than building it, which is the
only reliable way to keep scope from leaking.

A discovery that genuinely blocks the current work is not a future improvement — it is
part of the current work, and it gets named as such rather than folded in quietly.

## Done

A change is done when:

1. It does what its scope said, and nothing its scope did not.
2. It was verified, and the verification is written in the PR with its real output.
3. Anything found but not built is recorded under Future Improvements.
4. The full diff has been read for drift — leftovers, unrelated edits, accidental files.
5. The engineer has approved and merged it.

Steps 1 through 4 are Claude's to complete before asking. Step 5 is not delegable.

## Not decided yet

Sprint 0 establishes the foundation and stops there. The following are genuinely open,
and are listed so they are recognized as unanswered rather than quietly invented the
first time they come up:

- How work is tracked before it becomes a branch — issues, a backlog file, or neither.
- What automation, if any, runs against this repository.
- How Rex's rules get applied to a project that is not Rex.
- How to tell whether Rex is working — what gets measured, and how often it is reviewed.

Each of these becomes a decision when there is real experience to base it on. Until
then, the honest answer is that it is not decided, and the simplest reasonable thing is
done in the moment.
