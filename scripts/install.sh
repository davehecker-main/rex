#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
codex_home=${CODEX_HOME:-"$HOME/.codex"}
claude_home=${CLAUDE_HOME:-"$HOME/.claude"}

install_file() {
  src=$1
  dest=$2
  mkdir -p "$(dirname -- "$dest")"
  cp "$src" "$dest"
  printf 'installed %s\n' "$dest"
}

install_file "$repo_dir/codex/agents/rex.toml" "$codex_home/agents/rex.toml"

# The command file calls the scripts by repo-relative path, but the installed copy runs
# from whatever repo the session is working in. Absolutize the call sites on the way out,
# or the digest step fails with "no such file" and the consult never happens.
install_command() {
  dest=$1
  tmp=$(mktemp)
  sed -e "s#scripts/rex-consult.sh#$repo_dir/scripts/rex-consult.sh#g" \
      -e "s#scripts/session-digest.mjs#$repo_dir/scripts/session-digest.mjs#g" \
      -e "s#scripts/log-intervention.mjs#$repo_dir/scripts/log-intervention.mjs#g" \
      "$repo_dir/claude/commands/rex.md" > "$tmp"
  mkdir -p "$(dirname -- "$dest")"
  cp "$tmp" "$dest"
  rm -f "$tmp"
  printf 'installed %s\n' "$dest"
}

install_command "$claude_home/commands/rex.md"

printf '\nRex runs on Codex. The scripts stay in this repo; the command file calls them\n'
printf 'from here:\n\n'
printf '  %s/scripts/session-digest.mjs\n' "$repo_dir"
printf '  %s/scripts/log-intervention.mjs\n\n' "$repo_dir"
printf 'Both need Node 18 or later and no dependencies.\n'
