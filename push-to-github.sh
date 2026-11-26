#!/usr/bin/env bash
# Push Cobra to GitHub.
# Usage: ./push-to-github.sh [repo-name] [--private|--public] [commit message]
# Needs git, and either the GitHub CLI (gh auth login) or an existing "origin" remote.
set -euo pipefail
cd "$(dirname "$0")"

REPO="${1:-cobra-chess}"
VIS="${2:---private}"
MSG="${3:-Update Cobra}"

command -v git >/dev/null || { echo "git is not installed."; exit 1; }

[ -d .git ] || { git init -q -b main; echo "Initialised git repository."; }

[ -f .gitignore ] || printf '.DS_Store\nnode_modules/\n*.log\n' > .gitignore

git add -A
if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -q -m "$MSG"
  echo "Committed: $MSG"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh repo create "$REPO" "$VIS" --source=. --remote=origin --push
    echo "Created and pushed: $(git remote get-url origin)"
    exit 0
  fi
  echo "No 'origin' remote and the GitHub CLI isn't signed in."
  echo "Either run 'gh auth login' and re-run this script, or:"
  echo "  git remote add origin https://github.com/<you>/$REPO.git && ./push-to-github.sh"
  exit 1
fi

git push -u origin "$(git branch --show-current)"
echo "Pushed to $(git remote get-url origin)"
