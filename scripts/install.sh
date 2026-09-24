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
      -e "s#scripts/rex-report.mjs#$repo_dir/scripts/rex-report.mjs#g" \
      -e "s#scripts/rex-report.sh#$repo_dir/scripts/rex-report.sh#g" \
      "$repo_dir/claude/commands/rex.md" > "$tmp"
  mkdir -p "$(dirname -- "$dest")"
  cp "$tmp" "$dest"
  rm -f "$tmp"
  printf 'installed %s\n' "$dest"
}

install_command "$claude_home/commands/rex.md"

# Record the first-install time once, in Rex's existing state dir, and never touch it again.
# The source-inventory report prefers this over any file mtime, because a reinstall rewrites
# every installed file's mtime but must not move "since installed".
state_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}/rex
milestone="$state_dir/installed-at"
if [ ! -f "$milestone" ]; then
  mkdir -p "$state_dir"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$milestone"
  printf 'recorded install milestone %s\n' "$milestone"
fi

printf '\nRex runs on Codex. The scripts stay in this repo; the command file calls them\n'
printf 'from here:\n\n'
printf '  %s/scripts/session-digest.mjs\n' "$repo_dir"
printf '  %s/scripts/log-intervention.mjs\n\n' "$repo_dir"
printf 'Both need Node 22.5 or later (for node:sqlite) and no dependencies.\n'
