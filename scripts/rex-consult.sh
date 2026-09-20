#!/bin/bash
# Consult Rex about one session.
#
#   scripts/rex-consult.sh <digest.md> [question]
#
# codex exec has no --agent flag and does not read ~/.codex/agents/, so the persona
# travels in the prompt. Everything else follows the codex-exec rules that are easy to
# get wrong: a quoted heredoc rather than command-line interpolation, an mktemp answer
# file so a failed run cannot serve the previous answer, and < /dev/null or it waits
# forever on stdin at 0% CPU without ever erroring.

set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
digest=${1:?usage: rex-consult.sh <digest.md> [question]}
question=${2:-"Read the digest and tell me what you see."}
interventions=${REX_LOG:-"${XDG_DATA_HOME:-$HOME/.local/share}/rex/interventions.jsonl"}

[ -f "$digest" ] || { echo "no digest at $digest" >&2; exit 1; }
mkdir -p "$(dirname -- "$interventions")"
touch "$interventions"

persona=$(python3 - "$repo_dir/codex/agents/rex.toml" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r'developer_instructions = """\n(.*)"""\s*$', s, re.S)
if not m:
    sys.exit("could not read developer_instructions out of rex.toml")
print(m.group(1))
PY
)

prompt=$(mktemp /tmp/rex-prompt.XXXXXX)
answer=$(mktemp /tmp/rex-answer.XXXXXX)


{
  printf '%s\n\n---\n\n' "$persona"
  printf 'Claude is asking:\n\n````\n%s\n````\n\n' "$question"
  printf 'Sources — read these yourself:\n- %s\n- %s\n' "$digest" "$interventions"
} > "$prompt"

# codex narrates the whole session on stderr, prompt included. Keep it out of the caller's
# output, but hold on to it so a failure reports something better than silence.
stderr_log=$(mktemp /tmp/rex-stderr.XXXXXX)
trap 'rm -f "$prompt" "$stderr_log"' EXIT

if ! codex exec --cd "$repo_dir" --sandbox read-only -o "$answer" "$(cat "$prompt")" \
  < /dev/null > /dev/null 2> "$stderr_log"; then
  echo "codex exec failed:" >&2
  tail -20 "$stderr_log" >&2
  exit 1
fi

[ -s "$answer" ] || { echo "codex exec wrote no answer" >&2; tail -20 "$stderr_log" >&2; exit 1; }
cat "$answer"
