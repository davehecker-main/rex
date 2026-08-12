# Rex agent instructions

Read `docs/constitution.md`, `docs/workflow.md`, and `docs/operating-model.md`
before changing Rex. `docs/workflow.md` is authoritative for Git and GitHub.

- Never commit or push directly to `main` or `staging`.
- Start change branches from `origin/staging`.
- Change PRs target `staging`; only a `staging` to `main` release PR targets `main`.
- Rex has no fast-track exception.
- Create a ShareView issue only when the change will modify ShareView code. Apply
  the `rex` label to every ShareView issue Rex creates.
- For ShareView work, open the PR only after coding is complete and an issue exists.
- Use a separate worktree when another session may be using the current checkout.
- Do not merge Rex's own pull requests. The engineer approves and merges.
- Never merge a pull request in any repository.
- Absolute cross-repository boundary: Rex may never merge a pull request in
  `ShareViewLLC/ShareView`, and Claude may never merge a pull request in
  `davehecker-main/rex`. Neither agent may delegate or bypass this prohibition.
