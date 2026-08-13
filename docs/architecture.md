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
 codex exec / codex exec resume
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

Recovery is deliberately narrow. Only missing-session diagnostics actually observed
on Codex's stderr trigger replacement. Other resume failures preserve the stored
session ID and are reported to the caller; model-influenced JSON output is never
treated as a transport diagnostic.

Only one call may use the Rex session at a time. Concurrent clients wait for the lock,
up to the configured timeout, rather than writing to the same Codex rollout
simultaneously.

For agent clients, `rex mcp-server` exposes the same path over stdio MCP. It offers one
tool, `ask_rex`, and no general shell or filesystem capability.

ShareView is the first configured agent client. Its project MCP configuration starts
`rex mcp-server`, and its Claude Code `/rex` command uses a stateless proxy that calls
`ask_rex` exactly once and returns Rex's response unchanged. Session identity,
serialization, bootstrap, and recovery remain owned by the wrapper, not by the
ShareView client or its proxy.

## Permissions

Rex runs in Codex's read-only sandbox by default. Rex may inspect repositories,
analyze, advise, review, and propose. Repository mutations and consequential actions
belong to a separately authorized implementation workflow. The wrapper does not grant
Claude general shell or filesystem access; integrations should expose only the narrow
ability to ask Rex.

GitHub access is a separate permission boundary from the filesystem sandbox. When the
wrapper finds its dedicated credential in the macOS Keychain item
`com.davidhecker.rex.github-read` for account `rex`, it configures GitHub's official
remote MCP server for the Rex invocation with an allow-list of issue and pull-request
read/list/search tools and the server's read-only filter. The token must be fine-grained,
restricted to `ShareViewLLC/ShareView`, and grant Metadata read, Pull requests read, and
Issues read/write. The wider Issues credential permission is not the policy boundary:
the wrapper verifies the live login and immutable user ID as `dr-rex-phd` and exposes
only fixed operations. Rex ignores the user's global Codex configuration so unrelated MCP
servers and plugins are unavailable. The wrapper holds the token in a short-lived
loopback MCP proxy outside the Codex process. The proxy fixes the upstream host, read
tool allow-list, and read-only header, and implements the two allowed issue mutations
itself. The token is unavailable to model-run shell commands and is never written to
arguments, state, or invocation telemetry. If it is absent, the GitHub MCP server is not
configured.

Normal invocations add one mutation tool: comment on a ShareView issue. The wrapper
first resolves the number through GraphQL's typed `Issue` field and then comments on
that immutable node ID; a pull request with the same number fails the type check. Issue
creation is exposed only when Dave directly runs `rex ask
--allow-shareview-issue-create`. That grant is unavailable through `mcp-server`, permits
at most one creation, and is consumed before the request so an ambiguous failure cannot
be retried into a duplicate. Neither operation accepts an owner, repository, URL, node
ID, labels, or arbitrary GraphQL document from the model. The creation request always
sets exactly the `rex` label.

The direct `create-shareview-issue` command uses that same identity verification,
fixed request, one-use grant, and audit handler without starting Codex. This is the
deterministic path for an explicit creation instruction; it avoids broadening Codex's
approval or filesystem sandbox merely to authorize one GitHub mutation.
After creation, the wrapper reads the issue back and requires the `rex` label to be
present. A missing label is a failed postcondition, while an unreadable verification is
unknown; both retain the created issue number and URL in the audit and neither retries.

Every attempted mutation writes a separate `github-mutations.jsonl` audit record in the
Rex state directory. Records include the verified identity, operation, target, content
digest and length, correlation ID, GitHub request ID, authorization state, and outcome;
credentials and request bodies are never recorded. The preliminary `attempted` record
is durable before dispatch. A missing final record therefore means the outcome is
explicitly unresolved rather than falsely denied.

These controls are intentionally independent: Codex's read-only sandbox prevents
filesystem mutation; the upstream MCP read-only filter removes GitHub's general
mutation tools; the proxy exposes only fixed, audited issue operations; and the
repository-scoped credential prevents access outside ShareView.

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
