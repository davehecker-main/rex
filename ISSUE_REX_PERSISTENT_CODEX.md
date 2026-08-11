# ShareView issue #1334: Persistent Rex

Issue tracking and discussion live in
[`ShareViewLLC/ShareView#1334`](https://github.com/ShareViewLLC/ShareView/issues/1334).

The accepted MVP is an on-demand, resume-first wrapper around `codex exec`, not a
permanent daemon:

1. Persist one canonical Codex session ID.
2. Resume it for every Rex request.
3. Bootstrap only when creating or replacing the session.
4. Serialize calls with a global lock.
5. Run read-only by default.
6. Return the final Rex message without CLI progress output.
7. Keep this repository as durable memory and ShareView as the issue system.

SQLite, an asynchronous message bus, app-server integration, remote hosting, and
multiple Rex threads are deferred until real usage demonstrates a need.

See `docs/architecture.md` for the durable design record.
