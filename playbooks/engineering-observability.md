# Playbook: Engineering Observability Assessment

Run this when onboarding Rex to a software project, before proposing any change to it.

## Why this exists

- A system cannot be improved faster than it can be observed. Recommendations made
  without evidence are guesses that arrive with confidence.
- The first thing worth knowing about a project is not what is wrong with it, but which
  questions it can already answer about itself.
- The assessment is deliberately separated from improvement so the improvement is
  argued from findings rather than from first impressions.

## What Rex inspects

Only what already exists. Nothing is instrumented, added, or run for the first time
during an assessment.

- **The repository** — structure, history, and what the commit record shows about how
  changes actually arrive.
- **The written rules** — the docs a contributor is expected to follow, and whether the
  code reflects them.
- **The path to production** — how a change gets from a working copy to users, and
  which steps are automatic versus remembered.
- **The check surface** — what is verified automatically, what is verified by hand, and
  what is verified by hope.
- **The failure record** — what has broken, how it was noticed, and how it was
  diagnosed.
- **The human loop** — where the engineer's attention is actually spent, and which of
  that is unavoidable.

## Questions Rex attempts to answer

- Can I tell whether the system is currently working, without asking someone?
- When something breaks, how is it noticed — and would it be noticed if nobody was
  looking?
- How long does it take to know a change is safe, and what does that answer rest on?
- What is verified automatically, and what only appears verified?
- Which failures have happened more than once?
- Where does the engineer's time go that a machine could be answering instead?
- What would be lost, and what would be unrecoverable, if the worst plausible failure
  happened today?

## What should already exist

If these are missing, that absence is itself the first finding — not a blocker.

- A way to run the system, and a way to run its checks.
- A statement of what the system is for and who uses it.
- Some record of past failures, however informal.
- A known path to production, even if it is manual.

## What Rex deliberately does not collect

- Individual productivity measures — commit counts, lines, velocity. They measure
  motion, not leverage.
- Product and business analytics. Rex assesses the engineering system, not the product.
- Anything requiring new instrumentation. Adding a measurement changes the system being
  assessed and belongs to a later decision.
- Credentials, secrets, or customer data. An assessment never needs them.
- Style opinions unattached to a failure. Taste is not a finding.

## How Rex identifies observability gaps

A gap is a question from the list above that the system cannot answer from evidence it
already has. Each is classified by why:

- **Unanswerable** — the evidence does not exist anywhere.
- **Manual only** — answerable, but by a human reading, remembering, or checking by hand.
- **Unwatched** — the evidence exists and nobody looks at it.

Gaps are then ranked by consequence, not by ease of fixing: how bad is it to be wrong
about this, and how long would being wrong go unnoticed. A cheap fix for a harmless gap
ranks below an expensive fix for a silent one.

## Deliverable

One written assessment, committed to the project it describes:

- **What was inspected**, and what could not be.
- **The questions, answered** — each with the evidence it rests on, or marked
  unanswerable and why.
- **Gaps, ranked by consequence**, each classified as unanswerable, manual only, or
  unwatched.
- **The smallest next step** — the single highest-consequence gap, named. One.

The assessment is not a remediation plan and does not propose a solution for each gap.
It ends by stating what is true, and what should be decided next. Deciding is the
engineer's.
