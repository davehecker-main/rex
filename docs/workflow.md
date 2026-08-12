# Rex Git and GitHub Workflow

This is Rex's authoritative checkout, check-in, and release process. It is modeled
on ShareView's staging-first workflow, but lives here so every Rex client receives
the same stable instructions.

## Protected branches

`main` and `staging` are protected by policy:

- Never commit or push directly to either branch.
- Never do implementation work while either branch is checked out.
- Never force-push either branch.
- Do not use a fast-track label, administrator bypass, or alternate PR base.

The current private GitHub plan does not support branch protections or rulesets.
These rules are enforced by agent instructions, the helper, review, and CI where
GitHub permits. A plan upgrade (or public repository) is required for server-side
protection.

## Checkout: begin a change

One scoped change uses one short-lived branch and one draft pull request.

1. State the scope and exclusions.
2. Check active worktrees and preserve unrelated work.
3. Fetch `origin/staging`.
4. Create a feature branch and separate worktree from `origin/staging`.
5. Make and verify only the scoped change.

```bash
./bin/rex-workflow checkout rex-1234-short-description
```

Do not create a ShareView issue for Rex-repository-only work. Create a ShareView issue
only when the planned change will branch and check code into the ShareView repository.
Every ShareView issue Rex creates must receive the `rex` label.

## Check-in: publish a change

Before check-in, run the relevant tests, review the full diff, update Rex's durable
docs when necessary, and stage explicit paths only; never use `git add .` or
`git add -A`.

```bash
./bin/rex-workflow checkin \
  --message "Describe the scoped change" \
  --verification "python3 -m unittest discover -s tests -v (passed)" \
  path/to/file another/path
```

The helper refuses protected branches, commits only named paths, pushes the feature
branch, and opens a draft PR targeting `staging`. The engineer reviews and merges;
Rex does not merge its own work.

For ShareView changes, coding must be complete and the `rex`-labeled ShareView issue
must exist before opening the ShareView PR. This timing requirement does not create
ShareView issues for changes confined to Rex or another repository. Rex never merges
a pull request in any repository.

## Absolute cross-repository merge boundary

- Rex may never merge a pull request in `ShareViewLLC/ShareView`.
- Claude may never merge a pull request in `davehecker-main/rex`.
- Neither agent may enable auto-merge, ask another automation to merge, use an
  administrator bypass, or otherwise cause the prohibited merge indirectly.

Only the engineer may merge across this Rex/Claude repository boundary. This rule is
absolute and overrides any repository automation, label, command, or general autonomy
permission that would otherwise allow the merge.

## Verify on staging

After merge to `staging`, verify the integrated result there and record failures or
follow-up in the ShareView issue. Feature-branch tests alone do not make a release.

## Release

A release requires an explicit instruction from the engineer.

1. Confirm the candidate commits are exactly `main..staging`.
2. Confirm associated issues are verified.
3. Run release checks and report their real results.
4. Open a `staging` to `main` PR using a merge commit.
5. The engineer approves and merges.
6. Perform and record post-release verification.

No other head branch may target `main`. No feature change may bypass `staging`.

## Concurrent sessions and cleanup

Assume another client may use the primary checkout. Inspect `git worktree list` and
`git status` before acting. Do not switch, reset, clean, delete, or reuse another
session's branch or worktree. Remove a worktree only after confirming its branch is
merged and its working tree is clean.
