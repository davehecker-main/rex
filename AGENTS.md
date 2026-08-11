# Rex agent instructions

Read `docs/constitution.md`, `docs/workflow.md`, and `docs/operating-model.md`
before changing Rex. `docs/workflow.md` is authoritative for Git and GitHub.

- Never commit or push directly to `main` or `staging`.
- Start change branches from `origin/staging`.
- Change PRs target `staging`; only a `staging` to `main` release PR targets `main`.
- Rex has no fast-track exception.
- Work may begin without an issue, but a ShareView issue and link are required
  before check-in or merge to `staging`.
- Use a separate worktree when another session may be using the current checkout.
- Do not merge Rex's own pull requests. The engineer approves and merges.

