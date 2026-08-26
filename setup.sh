#!/bin/bash
# One-shot: create the GitHub repo, push, and upload webhook URLs as secrets.
# Prereqs: `brew install gh` then `gh auth login` (choose HTTPS, login via browser).
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-yard-watch}"

command -v gh >/dev/null || { echo "gh not found — run: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "not logged in — run: gh auth login"; exit 1; }

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --private --source=. --push
else
  git push -u origin HEAD
fi

node -e '
const c = require("./config.json");
const m = {
  WEBHOOK_DAILY: c.webhooks?.daily,
  WEBHOOK_LIVE: c.webhooks?.live,
  WEBHOOK_UGC: c.webhooks?.ugc,
  WEBHOOK_WEEKLY: c.webhooks?.weekly,
  WEBHOOK_DCL: c.webhooks?.dcl,
  WEBHOOK_DEFAULT: c.discordWebhookUrl,
  ...(c.settings ?? {}),
};
for (const [k, v] of Object.entries(m)) if (v) console.log(k + "\t" + v);
' | while IFS=$'\t' read -r key val; do
  gh secret set "$key" --body "$val"
done

echo
echo "Repo ready. Test the cloud watcher now with:"
echo "  gh workflow run watch.yml && sleep 45 && gh run list --limit 3"
