import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

export type UsageLimitScope = "global" | "user" | "topic";

export type UsageBucketKey = {
  scope: UsageLimitScope;
  key: string;
};

export type UsageWindow = {
  kind: "daily";
  id: string; // YYYY-MM-DD in configured TZ
  timeZone: string;
};

export type QuotaLimitsConfig = {
  enabled?: boolean;
  timeZone?: string;
  maxOutputReserveTokens?: number;
  // Seed admins if DB has none yet.
  bootstrapAdminUserIds?: string[];
  limits?: {
    globalDailyTokens?: number;
    perUserDailyTokens?: number;
    perTopicDailyTokens?: number;
  };
};

const DEFAULT_TIMEZONE = "Asia/Singapore";
const DEFAULT_MAX_OUTPUT_RESERVE = 800;

// Reasonable v1 defaults (daily window) if user doesn't configure limits.
const DEFAULT_GLOBAL_DAILY_TOKENS = 200_000;
const DEFAULT_USER_DAILY_TOKENS = 40_000;
const DEFAULT_TOPIC_DAILY_TOKENS = 60_000;

function resolveTelegramUsageLimitsConfig(cfg: OpenClawConfig): QuotaLimitsConfig {
  const telegramCfg = (cfg.channels as any)?.telegram;
  const raw = (telegramCfg?.usageLimits ?? {}) as QuotaLimitsConfig;
  return raw ?? {};
}

function resolveDbPath(): string {
  return path.join(STATE_DIR, "telegram", "usage-limits.sqlite");
}

function openDb(): DatabaseSync {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(resolveDbPath());
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS admins (
      user_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS limits (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      limit_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, key, window_kind)
    );

    CREATE TABLE IF NOT EXISTS usage (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_id TEXT NOT NULL,
      used_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, key, window_kind, window_id)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      run_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_id TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, scope, key, window_kind, window_id)
    );
  `);
  return db;
}

export function resolveUsageWindow(cfg: OpenClawConfig): UsageWindow {
  const limitsCfg = resolveTelegramUsageLimitsConfig(cfg);
  const timeZone = limitsCfg.timeZone?.trim() || DEFAULT_TIMEZONE;

  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const id = year && month && day ? `${year}-${month}-${day}` : new Date().toISOString().slice(0, 10);

  return { kind: "daily", id, timeZone };
}

export function estimateTokensFromText(input: string): number {
  // Very rough heuristic: ~4 chars/token.
  const trimmed = input?.trim() ?? "";
  if (!trimmed) {
    return 0;
  }
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function resolveMaxOutputReserveTokens(cfg: OpenClawConfig): number {
  const limitsCfg = resolveTelegramUsageLimitsConfig(cfg);
  const value = limitsCfg.maxOutputReserveTokens;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : DEFAULT_MAX_OUTPUT_RESERVE;
}

export function isUsageLimitsEnabled(cfg: OpenClawConfig): boolean {
  const limitsCfg = resolveTelegramUsageLimitsConfig(cfg);
  return limitsCfg.enabled !== false;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureBootstrapAdmins(cfg: OpenClawConfig) {
  const limitsCfg = resolveTelegramUsageLimitsConfig(cfg);
  const seeds = (limitsCfg.bootstrapAdminUserIds ?? []).map(String).filter(Boolean);
  if (seeds.length === 0) {
    return;
  }
  const db = openDb();
  const count = db.prepare("SELECT COUNT(1) as c FROM admins").get() as { c: number };
  if ((count?.c ?? 0) > 0) {
    return;
  }
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO admins(user_id, created_at) VALUES(?, ?)",
  );
  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    for (const id of seeds) {
      stmt.run(id, createdAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function isQuotaAdmin(cfg: OpenClawConfig, userId: string): boolean {
  ensureBootstrapAdmins(cfg);
  const db = openDb();
  const row = db
    .prepare("SELECT user_id FROM admins WHERE user_id = ?")
    .get(String(userId));
  return Boolean(row);
}

export function addQuotaAdmin(cfg: OpenClawConfig, userId: string) {
  ensureBootstrapAdmins(cfg);
  const db = openDb();
  db.prepare("INSERT OR IGNORE INTO admins(user_id, created_at) VALUES(?, ?)").run(
    String(userId),
    nowIso(),
  );
}

export function removeQuotaAdmin(cfg: OpenClawConfig, userId: string) {
  ensureBootstrapAdmins(cfg);
  const db = openDb();
  db.prepare("DELETE FROM admins WHERE user_id = ?").run(String(userId));
}

export function setLimitTokens(params: {
  cfg: OpenClawConfig;
  scope: UsageLimitScope;
  key: string;
  windowKind: UsageWindow["kind"];
  limitTokens: number;
}) {
  ensureBootstrapAdmins(params.cfg);
  const db = openDb();
  db.prepare(
    `INSERT INTO limits(scope, key, window_kind, limit_tokens, updated_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(scope, key, window_kind)
     DO UPDATE SET limit_tokens=excluded.limit_tokens, updated_at=excluded.updated_at`,
  ).run(
    params.scope,
    params.key,
    params.windowKind,
    Math.max(0, Math.trunc(params.limitTokens)),
    nowIso(),
  );
}

function resolveConfiguredLimitTokens(cfg: OpenClawConfig, scope: UsageLimitScope): number | null {
  const limitsCfg = resolveTelegramUsageLimitsConfig(cfg);
  const defaults = limitsCfg.limits;
  const value =
    scope === "global"
      ? (defaults?.globalDailyTokens ?? DEFAULT_GLOBAL_DAILY_TOKENS)
      : scope === "user"
        ? (defaults?.perUserDailyTokens ?? DEFAULT_USER_DAILY_TOKENS)
        : (defaults?.perTopicDailyTokens ?? DEFAULT_TOPIC_DAILY_TOKENS);
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

export function getLimitTokens(params: {
  cfg: OpenClawConfig;
  scope: UsageLimitScope;
  key: string;
  windowKind: UsageWindow["kind"];
}): number | null {
  ensureBootstrapAdmins(params.cfg);
  const db = openDb();
  const row = db
    .prepare(
      "SELECT limit_tokens as limitTokens FROM limits WHERE scope = ? AND key = ? AND window_kind = ?",
    )
    .get(params.scope, params.key, params.windowKind) as { limitTokens?: number } | undefined;
  if (row && typeof row.limitTokens === "number") {
    return row.limitTokens;
  }
  return resolveConfiguredLimitTokens(params.cfg, params.scope);
}

function getUsedTokens(db: DatabaseSync, bucket: UsageBucketKey, window: UsageWindow): number {
  const row = db
    .prepare(
      `SELECT used_tokens as used FROM usage
       WHERE scope = ? AND key = ? AND window_kind = ? AND window_id = ?`,
    )
    .get(bucket.scope, bucket.key, window.kind, window.id) as { used?: number } | undefined;
  return typeof row?.used === "number" && Number.isFinite(row.used) ? Math.max(0, row.used) : 0;
}

function getReservedTokens(db: DatabaseSync, bucket: UsageBucketKey, window: UsageWindow): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(reserved_tokens), 0) as reserved FROM reservations
       WHERE scope = ? AND key = ? AND window_kind = ? AND window_id = ?`,
    )
    .get(bucket.scope, bucket.key, window.kind, window.id) as { reserved?: number } | undefined;
  return typeof row?.reserved === "number" && Number.isFinite(row.reserved)
    ? Math.max(0, row.reserved)
    : 0;
}

export type ReserveResult =
  | { ok: true; reservedTokens: number }
  | { ok: false; reason: string; remaining: Record<string, number> };

export function reserveTokens(params: {
  cfg: OpenClawConfig;
  runId: string;
  window: UsageWindow;
  buckets: UsageBucketKey[];
  reserveTokens: number;
}): ReserveResult {
  ensureBootstrapAdmins(params.cfg);
  const db = openDb();
  const reserve = Math.max(0, Math.trunc(params.reserveTokens));
  if (!reserve) {
    return { ok: true, reservedTokens: 0 };
  }

  const remaining: Record<string, number> = {};
  for (const bucket of params.buckets) {
    const limit = getLimitTokens({
      cfg: params.cfg,
      scope: bucket.scope,
      key: bucket.key,
      windowKind: params.window.kind,
    });
    if (limit == null) {
      continue; // unlimited bucket
    }
    const used = getUsedTokens(db, bucket, params.window);
    const reservedAlready = getReservedTokens(db, bucket, params.window);
    const avail = limit - used - reservedAlready;
    remaining[`${bucket.scope}:${bucket.key}`] = avail;
    if (avail < reserve) {
      return {
        ok: false,
        reason: `quota exceeded for ${bucket.scope}`,
        remaining,
      };
    }
  }

  const stmt = db.prepare(
    `INSERT INTO reservations(run_id, scope, key, window_kind, window_id, reserved_tokens, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, scope, key, window_kind, window_id)
     DO UPDATE SET reserved_tokens=excluded.reserved_tokens`,
  );
  const createdAt = nowIso();
  db.exec("BEGIN");
  try {
    for (const bucket of params.buckets) {
      stmt.run(
        params.runId,
        bucket.scope,
        bucket.key,
        params.window.kind,
        params.window.id,
        reserve,
        createdAt,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { ok: true, reservedTokens: reserve };
}

export function reconcileTokens(params: {
  cfg: OpenClawConfig;
  runId: string;
  window: UsageWindow;
  buckets: UsageBucketKey[];
  actualTokens: number;
}) {
  ensureBootstrapAdmins(params.cfg);
  const db = openDb();
  const actual = Math.max(0, Math.trunc(params.actualTokens));
  const upsert = db.prepare(
    `INSERT INTO usage(scope, key, window_kind, window_id, used_tokens, updated_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, key, window_kind, window_id)
     DO UPDATE SET used_tokens = usage.used_tokens + excluded.used_tokens, updated_at = excluded.updated_at`,
  );
  const del = db.prepare(
    `DELETE FROM reservations
     WHERE run_id = ? AND scope = ? AND key = ? AND window_kind = ? AND window_id = ?`,
  );
  const updatedAt = nowIso();
  db.exec("BEGIN");
  try {
    for (const bucket of params.buckets) {
      if (actual > 0) {
        upsert.run(bucket.scope, bucket.key, params.window.kind, params.window.id, actual, updatedAt);
      }
      del.run(params.runId, bucket.scope, bucket.key, params.window.kind, params.window.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function releaseReservation(params: {
  cfg: OpenClawConfig;
  runId: string;
  window: UsageWindow;
  buckets: UsageBucketKey[];
}) {
  ensureBootstrapAdmins(params.cfg);
  const db = openDb();
  const del = db.prepare(
    `DELETE FROM reservations
     WHERE run_id = ? AND scope = ? AND key = ? AND window_kind = ? AND window_id = ?`,
  );
  db.exec("BEGIN");
  try {
    for (const bucket of params.buckets) {
      del.run(params.runId, bucket.scope, bucket.key, params.window.kind, params.window.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getUsageSnapshot(params: {
  cfg: OpenClawConfig;
  window: UsageWindow;
  bucket: UsageBucketKey;
}): { limitTokens: number | null; usedTokens: number; reservedTokens: number; remainingTokens: number | null } {
  ensureBootstrapAdmins(params.cfg);
  const db = openDb();
  const limit = getLimitTokens({
    cfg: params.cfg,
    scope: params.bucket.scope,
    key: params.bucket.key,
    windowKind: params.window.kind,
  });
  const used = getUsedTokens(db, params.bucket, params.window);
  const reserved = getReservedTokens(db, params.bucket, params.window);
  const remaining = limit == null ? null : limit - used - reserved;
  return { limitTokens: limit, usedTokens: used, reservedTokens: reserved, remainingTokens: remaining };
}
