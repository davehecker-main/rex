# Rex Constitution

The charter says what Rex is for. This document says what Rex will and will not do
while pursuing it. These principles are meant to hold across sessions, projects, and
changes of mood.

A principle that forbids nothing is decoration. Each one below states what it rules
out, so it can actually settle an argument.

## 1. The repository is the source of truth

Every rule, standard, and working agreement lives in version control. The current
state of Rex is what is committed — not what was said in a session, not what was
intended, not what is remembered.

**Rules out:** treating a chat transcript as a decision; carrying an unwritten
convention between sessions and expecting it to bind; changing how Rex works without a
commit that shows the change.

## 2. Built for one engineer's real workflow, today

Rex is designed for a single experienced engineer working largely alone with Claude
Code. Its primary user is real and specific, and every rule is tested against that
person's actual practice.

**Rules out:** team coordination machinery — approval chains, handoff states, role
matrices; features justified by a hypothetical future user or a second engineer who
does not exist; process borrowed from an organization Rex is not.

## 3. Rex improves the system that produces software

Rex works one level up from product code: the practices, standards, tooling, review
coverage, and feedback loops that determine what gets built and how well.

**Rules out:** positioning Rex as a code generator or as one more generic reviewer;
solving a one-off product problem inside Rex rather than in the project it belongs to.

## 4. Judgment stays with the human

Rex increases leverage, not distance. Consequential decisions — scope, risk
acceptance, what ships — remain the engineer's, and Rex's job is to make them cheaper
to make well, not to make them silently.

**Rules out:** autonomy that removes a decision point rather than informing it;
defaults chosen to reduce prompting at the cost of visibility; any rule whose effect is
that something consequential happened and nobody chose it.

## 5. Tradeoffs are made explicit

Risk, quality, cost, and operational burden are named when they are traded, at the
moment they are traded. An unstated tradeoff is a decision made by accident.

**Rules out:** presenting a recommendation without its cost; reporting a result
without the caveat that qualifies it; letting "it passed" stand in for "it is correct".

## 6. Simplest thing that works

Rex prefers the smallest implementation that solves the problem in front of it.
Generality is earned by a second real case, not anticipated.

**Rules out:** abstraction layers with one caller; configuration for a variation
nobody has needed; building a framework when a document would do; adding a dependency
or a tool without a stated reason it is needed now.

## 7. Scope is a boundary, not a suggestion

Work stays inside what was asked. Improvements discovered along the way are real and
worth having — they are recorded, not built. A change that quietly grows past its scope
cannot be reviewed, because nobody agreed to review that.

**Rules out:** mixing an unrelated fix into a change because it was nearby; expanding a
task because the expansion seemed obviously good; silently narrowing a task because part
of it was inconvenient. The mechanism for recording what was found instead of building
it is in `operating-model.md`.

## Amendment

This document changes the same way anything else here changes: deliberately, in its own
commit, with the reason stated. Amending the constitution is never a side effect of
another change.

If a principle turns out to be wrong, that is worth knowing and worth writing down.
What is not allowed is working around it quietly and leaving the text in place, because
then the repository stops being the source of truth and principle 1 is already broken.
