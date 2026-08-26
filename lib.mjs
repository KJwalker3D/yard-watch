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
export const DCL_WORLDS = g.dclWorlds ?? [];

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
} catch {
  // no local config (e.g. running in CI) — webhooks come from env
}

// tunables that shouldn't be public: env var (cloud secret) > config.json settings > fallback
export function setting(name, fallback) {
  return process.env[name] ?? cfg.settings?.[name] ?? fallback;
}

// noFallback: return "" instead of the default webhook when the category has
// no URL of its own (used for opt-in streams like "dcl")
export function webhookFor(category, noFallback = false) {
  const specific =
    process.env["WEBHOOK_" + category.toUpperCase()] || cfg.webhooks?.[category];
  if (specific || noFallback) return specific || "";
  return process.env.WEBHOOK_DEFAULT || cfg.discordWebhookUrl || "";
}
