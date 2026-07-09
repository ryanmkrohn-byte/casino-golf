#!/bin/bash
# Casino Golf — one-shot GitHub setup
# Usage: bash setup.sh YOUR_GITHUB_USERNAME

set -e

if [ -z "$1" ]; then
  echo "Usage: bash setup.sh YOUR_GITHUB_USERNAME"
  echo "Example: bash setup.sh ryansmith"
  exit 1
fi

USERNAME=$1

echo "→ Cleaning any old git state..."
rm -rf .git

echo "→ Initializing repository..."
git init -q
git add .
git commit -q -m "Casino Golf v1"
git branch -M main

echo "→ Connecting to github.com/$USERNAME/casino-golf ..."
git remote add origin "https://github.com/$USERNAME/casino-golf.git"

echo "→ Pushing (this overwrites whatever is in the repo)..."
git push -u origin main --force

echo ""
echo "✅ Done! Files pushed with correct structure."
echo ""
echo "Next steps in Vercel:"
echo "  1. Settings → General → Root Directory → make sure it's EMPTY (repo root)"
echo "  2. Deployments → ⋯ on latest → Redeploy"
