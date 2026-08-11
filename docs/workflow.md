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

An issue is optional at checkout, so investigation and implementation can start
without administrative overhead.

## Check-in: publish a change

A ShareView issue is mandatory before check-in and before merge to `staging`. Issue
management remains centralized in `ShareViewLLC/ShareView`.

Before check-in, run the relevant tests, review the full diff, update Rex's durable
docs when necessary, and identify the ShareView issue. Stage explicit paths only;
never use `git add .` or `git add -A`.

```bash
./bin/rex-workflow checkin \
  --issue 1234 \
  --message "Describe the scoped change" \
  --verification "python3 -m unittest discover -s tests -v (passed)" \
  path/to/file another/path
```

The helper refuses protected branches, commits only named paths, pushes the feature
branch, and opens a draft PR targeting `staging`. The engineer reviews and merges;
Rex does not merge its own work.

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

