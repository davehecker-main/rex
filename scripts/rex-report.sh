#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
request=${1:?usage: rex-report.sh <request-file> [report options]}
shift
evidence=$(mktemp)
judgment=$(mktemp)
trap 'rm -f "$evidence" "$judgment"' EXIT

node "$repo_dir/scripts/rex-report.mjs" --request-file "$request" --prepare "$evidence" "$@"
kind=$(node -e 'const fs=require("fs");console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).query.kind)' "$evidence")
case "$kind" in
  behavior|comparison|intervention|source-inventory)
    if "$repo_dir/scripts/rex-report-judge.sh" "$evidence" "$judgment"; then
      if node "$repo_dir/scripts/rex-report.mjs" --request-file "$request" --judgment-file "$judgment" "$@"; then
        exit 0
      fi
      echo "Rex judgment could not be included; delivering measured report only." >&2
    else
      echo "Rex judgment unavailable; delivering measured report only." >&2
    fi
    ;;
esac
node "$repo_dir/scripts/rex-report.mjs" --request-file "$request" "$@"
