// Shared config loading. Game list lives in games.json (safe to commit).
// Webhook URLs come from env vars (GitHub Actions secrets) first, then the
// local, gitignored config.json.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

const g = JSON.parse(readFileSync(join(ROOT, "games.json"), "utf8"));
export const GAMES = g.games ?? [];
export const UGC_ITEMS = g.ugcItems ?? [];

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
} catch {
  // no local config (e.g. running in CI) — webhooks come from env
}

export function webhookFor(category) {
  return (
    process.env["WEBHOOK_" + category.toUpperCase()] ||
    cfg.webhooks?.[category] ||
    process.env.WEBHOOK_DEFAULT ||
    cfg.discordWebhookUrl ||
    ""
  );
}
