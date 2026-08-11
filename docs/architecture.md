# Rex Architecture

## One logical Rex

Rex is one persistent Codex conversation backed by one canonical repository. It is
not a permanently running process. A client invokes Rex on demand, the wrapper resumes
the same Codex session, and the process exits after returning the response.

```text
Claude / ChatGPT Desktop / CLI
              |
              v
       Rex-owned wrapper
        |            |
        |            +-- single-invocation lock
        |            +-- canonical session ID
        v
 codex exec resume
        |
        v
 persistent Codex rollout + /rex repository
```

The session supplies conversational continuity. The repository supplies durable,
reviewable truth. ShareView is the issue-management system for Rex work.

## Invocation

The `rex` command acquires a global lock and reads the canonical Codex session ID. If
the ID exists, it calls `codex exec resume`. If it does not exist, or Codex reports
that the session no longer exists, the wrapper creates and bootstraps a replacement
session and atomically records its ID.

Only one call may use the Rex session at a time. Concurrent clients wait for the lock
rather than writing to the same Codex rollout simultaneously.

For agent clients, `rex mcp-server` exposes the same path over stdio MCP. It offers one
tool, `ask_rex`, and no general shell or filesystem capability.

## Permissions

Rex runs in Codex's read-only sandbox by default. Rex may inspect repositories,
analyze, advise, review, and propose. Repository mutations and consequential actions
belong to a separately authorized implementation workflow. The wrapper does not grant
Claude general shell or filesystem access; integrations should expose only the narrow
ability to ask Rex.

## Persistence

The wrapper stores only transport state: a versioned session ID file and a lock file.
On macOS the default location is:

```text
~/Library/Application Support/Rex/
```

Codex owns its rollout persistence. Rex promotes important decisions and operating
knowledge into this repository because rollouts can grow, compact, or become
unavailable. The session record is useful context, not the sole source of truth.

## Deferred components

The first version does not require hosting, a daemon, SQLite, an asynchronous message
bus, or Codex app-server. Those components require evidence from real usage before
being added.
