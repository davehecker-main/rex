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
install_file "$repo_dir/claude/commands/rex.md" "$claude_home/commands/rex.md"

printf '\nRex runs on Codex. The scripts stay in this repo; the command file calls them\n'
printf 'from here:\n\n'
printf '  %s/scripts/session-digest.mjs\n' "$repo_dir"
printf '  %s/scripts/log-intervention.mjs\n\n' "$repo_dir"
printf 'Both need Node 18 or later and no dependencies.\n'
