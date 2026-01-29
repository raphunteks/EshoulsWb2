"use strict";

const fs   = require("fs");
const path = require("path");

let defaultKv = null;
try {
  const kvModule = require("@vercel/kv");
  defaultKv = kvModule.kv || kvModule.default || null;
  if (!defaultKv) {
    console.warn("[serverv3] @vercel/kv ditemukan tapi tidak ada properti kv/default");
  }
} catch (err) {
  console.warn("[serverv3] @vercel/kv tidak tersedia, pakai file JSON lokal saja.", err.message);
  defaultKv = null;
}

// Base URL untuk summary giveaway web.
// Disarankan ENV: SUMMARY_BASE_URL=https://exc-webs.vercel.app/summary
const SUMMARY_BASE_URL = (
  process.env.SUMMARY_BASE_URL || "https://exc-webs.vercel.app/summary"
).replace(/\/+$/, "");

const DATA_DIR = path.join(__dirname, "data");

const FILE_REDEEMED_KEYS  = path.join(DATA_DIR, "redeemed-keys.json");
const FILE_DELETED_KEYS   = path.join(DATA_DIR, "deleted-keys.json");
const FILE_EXEC_USERS     = path.join(DATA_DIR, "exec-users.json");
const FILE_DISCORD_USERS  = path.join(DATA_DIR, "discord-users.json");
const FILE_GIVEAWAYS      = path.join(DATA_DIR, "giveaways.json");

const KV_REDEEMED_KEYS_KEY = "exhub:redeemed-keys";
const KV_DELETED_KEYS_KEY  = "exhub:deleted-keys";
const KV_EXEC_USERS_KEY    = "exhub:exec-users";
const KV_DISCORD_USERS_KEY = "exhub:discord-users";
const KV_GIVEAWAYS_KEY     = "exhub:discord:giveaways";

const FREE_USER_INDEX_PREFIX = "exhub:freekey:user:";
const FREE_TOKEN_PREFIX      = "exhub:freekey:token:";

const PAID_USER_INDEX_PREFIX = "exhub:paidkey:user:";
const PAID_TOKEN_PREFIX      = "exhub:paidkey:token:";

const EXEC_USERS_INDEX_KEY   = "exhub:exec-users:index";
const EXEC_USER_ENTRY_PREFIX = "exhub:exec-user:";

const DISCORD_USER_PROFILE_PREFIX = "exhub:discord:userprofile:";
const DISCORD_USER_INDEX_KEY      = "exhub:discord:userindex";

const PAID_PLAN_CONFIG_KEY            = "exhub:paidplan:config";
const LEGACY_GLOBAL_KEY_CONFIG_KV_KEY = "exhub:global-key-config";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================================
// Helper umum
// ============================================================================

function nowIso() {
  return new Date().toISOString();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonFileSafe(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return defaultValue;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[serverv3] readJsonFileSafe error:", filePath, err);
    return defaultValue;
  }
}

function writeJsonFileSafe(filePath, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[serverv3] writeJsonFileSafe error:", filePath, err);
  }
}

async function loadStore({ kvClient, kvKey, filePath, defaultValue }) {
  if (kvClient) {
    try {
      const value = await kvClient.get(kvKey);
      if (value != null) return value;
    } catch (err) {
      console.error("[serverv3] loadStore KV error:", kvKey, err);
    }
  }
  return readJsonFileSafe(filePath, defaultValue);
}

async function saveStore({ kvClient, kvKey, filePath, value }) {
  if (kvClient) {
    try {
      await kvClient.set(kvKey, value);
    } catch (err) {
      console.error("[serverv3] saveStore KV error:", kvKey, err);
    }
  }
  writeJsonFileSafe(filePath, value);
}

async function getKv(kvClient, key) {
  if (!kvClient) return null;
  try {
    return await kvClient.get(key);
  } catch (err) {
    console.error("[serverv3] KV get error:", key, err);
    return null;
  }
}

async function setKv(kvClient, key, value) {
  if (!kvClient) return;
  try {
    await kvClient.set(key, value);
  } catch (err) {
    console.error("[serverv3] KV set error:", key, err);
  }
}

async function delKv(kvClient, key) {
  if (!kvClient || !kvClient.del) return;
  try {
    await kvClient.del(key);
  } catch (err) {
    console.error("[serverv3] KV del error:", key, err);
  }
}

async function smembersKv(kvClient, key) {
  if (!kvClient || typeof kvClient.smembers !== "function") return [];
  try {
    const res = await kvClient.smembers(key);
    return Array.isArray(res) ? res : [];
  } catch (err) {
    console.error("[serverv3] KV smembers error:", key, err);
    return [];
  }
}

async function sremKv(kvClient, key, member) {
  if (!kvClient || typeof kvClient.srem !== "function") return;
  try {
    await kvClient.srem(key, member);
  } catch (err) {
    console.error("[serverv3] KV srem error:", key, member, err);
  }
}

// ============================================================================
// Paid plan config + generator manual
// ============================================================================

async function loadPaidPlanDurations(opts = {}) {
  const kvClient = opts.kvClient || defaultKv;
  const logger   = opts.logger || console;

  let monthDays      = 30;
  let threeMonthDays = 90;
  let sixMonthDays   = 180;
  let lifetimeDays   = 365;

  if (!kvClient) {
    return { monthDays, threeMonthDays, sixMonthDays, lifetimeDays };
  }

  try {
    let paidCfg = await getKv(kvClient, PAID_PLAN_CONFIG_KEY);

    if (!paidCfg || typeof paidCfg !== "object") {
      const legacyCfg = await getKv(kvClient, LEGACY_GLOBAL_KEY_CONFIG_KV_KEY);
      if (legacyCfg && typeof legacyCfg === "object") {
        paidCfg = legacyCfg.paidPlanConfig || legacyCfg;
      }
    }

    if (!paidCfg || typeof paidCfg !== "object") {
      return { monthDays, threeMonthDays, sixMonthDays, lifetimeDays };
    }

    const m = parseInt(
      paidCfg.monthDays ??
        paidCfg.paidMonthDays ??
        paidCfg.month ??
        paidCfg.monthTTL,
      10
    );
    if (!Number.isNaN(m) && m > 0) monthDays = m;

    const l = parseInt(
      paidCfg.lifetimeDays ??
        paidCfg.paidLifetimeDays ??
        paidCfg.lifetime ??
        paidCfg.lifetimeTTL,
      10
    );
    if (!Number.isNaN(l) && l > 0) lifetimeDays = l;

    const q = parseInt(
      paidCfg.threeMonthDays ??
        paidCfg.paid3MonthDays ??
        paidCfg["3monthDays"] ??
        paidCfg["3MonthDays"],
      10
    );
    if (!Number.isNaN(q) && q > 0) {
      threeMonthDays = q;
    } else {
      threeMonthDays = monthDays * 3;
    }

    const h = parseInt(
      paidCfg.sixMonthDays ??
        paidCfg.paid6MonthDays ??
        paidCfg["6monthDays"] ??
        paidCfg["6MonthDays"],
      10
    );
    if (!Number.isNaN(h) && h > 0) {
      sixMonthDays = h;
    } else {
      sixMonthDays = monthDays * 6;
    }
  } catch (err) {
    logger.error("[serverv3] loadPaidPlanDurations error:", err);
  }

  return { monthDays, threeMonthDays, sixMonthDays, lifetimeDays };
}

const PAID_KEY_PREFIX = "EXHUBPAID";

function generatePaidKeyToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  function chunk(len) {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }
  return `${PAID_KEY_PREFIX}-${chunk(4)}-${chunk(4)}-${chunk(4)}`;
}

async function generatePaidKeyForDiscordUser(opts) {
  const discordId = String(opts.discordId || "").trim();
  if (!discordId) {
    throw new Error("generatePaidKeyForDiscordUser: discordId kosong");
  }

  const kvClient = opts.kvClient || defaultKv;
  const logger   = opts.logger || console;

  let planRaw = String(opts.plan || "month").toLowerCase().trim();
  if (planRaw === "three" || planRaw === "3") planRaw = "3month";
  if (planRaw === "six"   || planRaw === "6") planRaw = "6month";

  const allowedPlans = ["month", "3month", "6month", "lifetime"];
  if (!allowedPlans.includes(planRaw)) {
    planRaw = "month";
  }

  const { monthDays, threeMonthDays, sixMonthDays, lifetimeDays } =
    await loadPaidPlanDurations({ kvClient, logger });

  let ttlDays;
  switch (planRaw) {
    case "3month":
      ttlDays = threeMonthDays;
      break;
    case "6month":
      ttlDays = sixMonthDays;
      break;
    case "lifetime":
      ttlDays = lifetimeDays;
      break;
    case "month":
    default:
      ttlDays = monthDays;
      break;
  }

  if (!ttlDays || ttlDays <= 0) {
    ttlDays = 30;
  }

  const nowMs      = Date.now();
  const expiresMs  = nowMs + ttlDays * MS_PER_DAY;
  const expiresIso = new Date(expiresMs).toISOString();

  let token = generatePaidKeyToken();
  if (kvClient) {
    for (let i = 0; i < 10; i++) {
      const existing = await getKv(kvClient, PAID_TOKEN_PREFIX + token);
      if (!existing) break;
      token = generatePaidKeyToken();
    }
  }

  const providerLabel =
    planRaw === "lifetime"
      ? "PAID LIFETIME"
      : planRaw === "6month"
      ? "PAID 6 MONTH"
      : planRaw === "3month"
      ? "PAID 3 MONTH"
      : "PAID MONTH";

  const record = {
    token,
    createdAt: nowMs,
    byIp: null,
    expiresAfter: expiresMs,
    type: planRaw,
    valid: true,
    deleted: false,
    ownerDiscordId: discordId,
    boundRobloxUserId: null,
    boundRobloxUsername: null,
    boundRobloxDisplayName: null,
    boundRobloxHWID: null,
    boundAt: null,
    provider: providerLabel,
    tier: "Paid",
    plan: planRaw,
    expiresAtIso: expiresIso
  };

  if (kvClient) {
    const paidTokenKey = PAID_TOKEN_PREFIX + token;
    await setKv(kvClient, paidTokenKey, record);

    const paidUserIdxKey = PAID_USER_INDEX_PREFIX + discordId;
    let tokens = await getKv(kvClient, paidUserIdxKey);
    if (!Array.isArray(tokens)) tokens = [];
    if (!tokens.includes(token)) tokens.push(token);
    await setKv(kvClient, paidUserIdxKey, tokens);

    logger.log(
      `[serverv3] generatePaidKeyForDiscordUser KV ok. discordId=${discordId}, plan=${planRaw}, token=${token}`
    );
  } else {
    let redeemedKeys = await loadStore({
      kvClient: null,
      kvKey:   KV_REDEEMED_KEYS_KEY,
      filePath: FILE_REDEEMED_KEYS,
      defaultValue: []
    });
    if (!Array.isArray(redeemedKeys)) redeemedKeys = [];

    redeemedKeys.push({
      ...record,
      store: "local-redeemed",
      legacy: true
    });

    await saveStore({
      kvClient: null,
      kvKey:   KV_REDEEMED_KEYS_KEY,
      filePath: FILE_REDEEMED_KEYS,
      value: redeemedKeys
    });

    logger.log(
      `[serverv3] generatePaidKeyForDiscordUser fallback file. discordId=${discordId}, plan=${planRaw}, token=${token}`
    );
  }

  return {
    discordId,
    token,
    plan: planRaw,
    expiresAtMs:  expiresMs,
    expiresAtIso: expiresIso,
    record
  };
}

// ============================================================================
// Delete semua data per Discord ID
// ============================================================================

async function deleteDiscordUserData(opts) {
  const discordId = String(opts.discordId || "").trim();
  const kvClient  = opts.kvClient || defaultKv;
  const logger    = opts.logger || console;

  if (!discordId) {
    throw new Error("deleteDiscordUserData: discordId kosong");
  }

  logger.log(`[serverv3] Delete data untuk Discord ID: ${discordId}`);

  const nowIsoStr = nowIso();
  const tokensSet = new Set();

  let redeemedKeys = await loadStore({
    kvClient,
    kvKey:   KV_REDEEMED_KEYS_KEY,
    filePath: FILE_REDEEMED_KEYS,
    defaultValue: []
  });

  if (!Array.isArray(redeemedKeys)) {
    logger.warn("[serverv3] WARNING: redeemedKeys bukan array. Nilai:", typeof redeemedKeys);
    redeemedKeys = [];
  }

  let deletedKeys = await loadStore({
    kvClient,
    kvKey:   KV_DELETED_KEYS_KEY,
    filePath: FILE_DELETED_KEYS,
    defaultValue: []
  });
  if (!Array.isArray(deletedKeys)) deletedKeys = [];

  let execUsers = await loadStore({
    kvClient,
    kvKey:   KV_EXEC_USERS_KEY,
    filePath: FILE_EXEC_USERS,
    defaultValue: {}
  });
  if (!execUsers || typeof execUsers !== "object") execUsers = {};

  let discordUsers = await loadStore({
    kvClient,
    kvKey:   KV_DISCORD_USERS_KEY,
    filePath: FILE_DISCORD_USERS,
    defaultValue: {}
  });
  if (!discordUsers || typeof discordUsers !== "object") discordUsers = {};

  const keysToKeep         = [];
  const keysToDeleteLegacy = [];

  for (const item of redeemedKeys) {
    if (!item) continue;
    const itemDiscordId = String(item.discordId || "").trim();
    if (itemDiscordId === discordId) {
      keysToDeleteLegacy.push(item);
      const t = String(item.token || item.key || "").trim();
      if (t) tokensSet.add(t);
    } else {
      keysToKeep.push(item);
    }
  }

  redeemedKeys = keysToKeep;

  if (keysToDeleteLegacy.length > 0) {
    const mappedDeleted = keysToDeleteLegacy.map((item) => {
      const copy = Object.assign({}, item);
      copy.deletedAt         = nowIsoStr;
      copy.deleteReason      = "discord-user-delete";
      copy.deleteByDiscordId = discordId;
      return copy;
    });
    deletedKeys = deletedKeys.concat(mappedDeleted);
  }

  let removedExecEntries = 0;
  for (const token of tokensSet) {
    if (execUsers[token]) {
      delete execUsers[token];
      removedExecEntries++;
    }
  }

  let removedProfile = false;
  if (discordUsers[discordId]) {
    delete discordUsers[discordId];
    removedProfile = true;
  }

  let removedFreeKeys = 0;
  let removedPaidKeys = 0;

  if (kvClient) {
    try {
      const freeIdxKey = FREE_USER_INDEX_PREFIX + discordId;
      const freeTokens = await getKv(kvClient, freeIdxKey);
      if (Array.isArray(freeTokens) && freeTokens.length > 0) {
        for (const rawToken of freeTokens) {
          const token = String(rawToken || "").trim();
          if (!token) continue;
          tokensSet.add(token);

          const recKey = FREE_TOKEN_PREFIX + token;
          const rec    = await getKv(kvClient, recKey);
          if (rec) {
            rec.deleted           = true;
            rec.valid             = false;
            rec.deletedAt         = nowIsoStr;
            rec.deletedByDiscordId = discordId;
            await setKv(kvClient, recKey, rec);
            removedFreeKeys++;
          }
        }
        await setKv(kvClient, freeIdxKey, []);
      }
    } catch (err) {
      logger.error("[serverv3] error bulk delete free keys:", err);
    }

    try {
      const paidIdxKey = PAID_USER_INDEX_PREFIX + discordId;
      const paidTokens = await getKv(kvClient, paidIdxKey);
      if (Array.isArray(paidTokens) && paidTokens.length > 0) {
        for (const rawToken of paidTokens) {
          const token = String(rawToken || "").trim();
          if (!token) continue;
          tokensSet.add(token);

          const recKey = PAID_TOKEN_PREFIX + token;
          const rec    = await getKv(kvClient, recKey);
          if (rec) {
            rec.deleted           = true;
            rec.valid             = false;
            rec.deletedAt         = nowIsoStr;
            rec.deletedByDiscordId = discordId;
            await setKv(kvClient, recKey, rec);
            removedPaidKeys++;
          }
        }
        await setKv(kvClient, paidIdxKey, []);
      }
    } catch (err) {
      logger.error("[serverv3] error bulk delete paid keys:", err);
    }
  }

  if (kvClient) {
    try {
      const entryIds = await smembersKv(kvClient, EXEC_USERS_INDEX_KEY);
      if (entryIds.length > 0) {
        for (const entryId of entryIds) {
          const entryKey = EXEC_USER_ENTRY_PREFIX + entryId;
          const entry    = await getKv(kvClient, entryKey);
          if (!entry) {
            await sremKv(kvClient, EXEC_USERS_INDEX_KEY, entryId);
            continue;
          }

          const entryDiscordId = entry.discordId || entry.ownerDiscordId || null;
          const entryToken     = String(
            entry.keyToken ||
            entry.token   ||
            entry.key     ||
            entry.keyId   ||
            ""
          ).trim();

          const matchDiscord = entryDiscordId && String(entryDiscordId) === discordId;
          const matchToken   = entryToken && tokensSet.has(entryToken);

          if (matchDiscord || matchToken) {
            await delKv(kvClient, entryKey);
            await sremKv(kvClient, EXEC_USERS_INDEX_KEY, entryId);
            removedExecEntries++;
          }
        }
      }
    } catch (err) {
      logger.error("[serverv3] error bulk delete exec index:", err);
    }
  }

  if (kvClient) {
    try {
      const profileKey      = DISCORD_USER_PROFILE_PREFIX + discordId;
      const existingProfile = await getKv(kvClient, profileKey);
      if (existingProfile) {
        removedProfile = true;
      }
      await delKv(kvClient, profileKey);

      const idxArr = await getKv(kvClient, DISCORD_USER_INDEX_KEY);
      if (Array.isArray(idxArr)) {
        const filtered = idxArr
          .map((id) => String(id || "").trim())
          .filter((id) => !!id && id !== discordId);
        await setKv(kvClient, DISCORD_USER_INDEX_KEY, filtered);
      }
    } catch (err) {
      logger.error("[serverv3] error cleanup discord user index/profile:", err);
    }
  }

  await saveStore({
    kvClient,
    kvKey:   KV_REDEEMED_KEYS_KEY,
    filePath: FILE_REDEEMED_KEYS,
    value:   redeemedKeys
  });

  await saveStore({
    kvClient,
    kvKey:   KV_DELETED_KEYS_KEY,
    filePath: FILE_DELETED_KEYS,
    value:   deletedKeys
  });

  await saveStore({
    kvClient,
    kvKey:   KV_EXEC_USERS_KEY,
    filePath: FILE_EXEC_USERS,
    value:   execUsers
  });

  await saveStore({
    kvClient,
    kvKey:   KV_DISCORD_USERS_KEY,
    filePath: FILE_DISCORD_USERS,
    value:   discordUsers
  });

  const removedKeysTotal =
    keysToDeleteLegacy.length + removedFreeKeys + removedPaidKeys;

  logger.log(
    `[serverv3] Discord ID ${discordId} → removed keys=${removedKeysTotal} (legacy=${keysToDeleteLegacy.length}, free=${removedFreeKeys}, paid=${removedPaidKeys}), execEntries=${removedExecEntries}, profileRemoved=${removedProfile}`
  );

  return {
    discordId,
    removedKeys:        removedKeysTotal,
    removedExecEntries,
    removedProfile
  };
}

// ============================================================================
// Giveaway helpers
// ============================================================================

async function loadGiveaways(kvClient, logger = console) {
  const giveaways = await loadStore({
    kvClient,
    kvKey:   KV_GIVEAWAYS_KEY,
    filePath: FILE_GIVEAWAYS,
    defaultValue: []
  });

  if (!Array.isArray(giveaways)) {
    logger.warn("[serverv3] WARNING: giveaways bukan array. Reset ke []");
    return [];
  }
  return giveaways;
}

async function saveGiveaways(kvClient, giveaways) {
  await saveStore({
    kvClient,
    kvKey:   KV_GIVEAWAYS_KEY,
    filePath: FILE_GIVEAWAYS,
    value:   Array.isArray(giveaways) ? giveaways : []
  });
}

function sanitizeGiveawayForPublic(g) {
  if (!g) return null;
  const copy = { ...g };
  if (Array.isArray(copy.winners)) {
    copy.winners = copy.winners.map((w) => ({
      discordId: w.discordId
    }));
  }
  return copy;
}

function normalizePlan(planRaw) {
  if (!planRaw) return null;
  let p = String(planRaw).toLowerCase().trim();
  if (p === "three" || p === "3") p = "3month";
  if (p === "six"   || p === "6") p = "6month";
  const allowed = ["month", "3month", "6month", "lifetime"];
  return allowed.includes(p) ? p : null;
}

async function createGiveawayRecord(opts) {
  const kvClient = opts.kvClient || defaultKv;
  const logger   = opts.logger || console;

  const guildId    = String(opts.guildId || "").trim();
  const channelId  = String(opts.channelId || "").trim();
  const messageId  = String(opts.messageId || "").trim();
  const creatorId  = String(opts.createdByDiscordId || "").trim();
  const prize      = String(opts.prize || "").trim();
  const description = String(opts.description || "").trim();
  const winnersCountRaw =
    opts.winnersCount != null ? opts.winnersCount : opts.numberOfWinners;
  const plan = normalizePlan(opts.plan);

  let winnersCount = parseInt(winnersCountRaw, 10);
  if (Number.isNaN(winnersCount) || winnersCount <= 0) winnersCount = 1;

  let durationMs = 0;
  if (opts.durationMs != null) {
    const v = parseInt(opts.durationMs, 10);
    if (!Number.isNaN(v) && v > 0) durationMs = v;
  }
  if (!durationMs && opts.durationSeconds != null) {
    const v = parseInt(opts.durationSeconds, 10);
    if (!Number.isNaN(v) && v > 0) durationMs = v * 1000;
  }
  if (!durationMs && opts.durationMinutes != null) {
    const v = parseInt(opts.durationMinutes, 10);
    if (!Number.isNaN(v) && v > 0) durationMs = v * 60 * 1000;
  }
  if (!durationMs) {
    durationMs = 24 * 60 * 60 * 1000;
  }

  const nowMs   = Date.now();
  const endsMs  = nowMs + durationMs;
  const endsIso = new Date(endsMs).toISOString();

  const randomPart = Math.random().toString(36).slice(2, 8);
  const id         = `ga_${nowMs}_${randomPart}`;

  // Dengan SUMMARY_BASE_URL=.../summary → summaryUrl=.../summary/ga/<id>
  const summaryUrl = `${SUMMARY_BASE_URL}/ga/${encodeURIComponent(id)}`;

  const giveaway = {
    id,
    guildId,
    channelId,
    messageId,
    createdByDiscordId: creatorId,
    createdAtIso: new Date(nowMs).toISOString(),
    durationMs,
    endsAtMs:  endsMs,
    endsAtIso: endsIso,
    winnersCount,
    prize,
    description,
    plan,
    status: "running",
    participants: [],
    winners: [],
    summaryUrl
  };

  const giveaways = await loadGiveaways(kvClient, logger);
  giveaways.push(giveaway);
  await saveGiveaways(kvClient, giveaways);

  logger.log(
    `[serverv3] createGiveawayRecord ok id=${id} guild=${guildId} channel=${channelId} winners=${winnersCount} plan=${plan || "none"}`
  );

  return giveaway;
}

async function joinGiveaway(opts) {
  const kvClient = opts.kvClient || defaultKv;
  const logger   = opts.logger || console;

  const giveawayId = String(opts.giveawayId || "").trim();
  const discordId  = String(opts.discordId || "").trim();

  if (!giveawayId) throw new Error("joinGiveaway: giveawayId kosong");
  if (!discordId)  throw new Error("joinGiveaway: discordId kosong");

  const giveaways = await loadGiveaways(kvClient, logger);
  const idx       = giveaways.findIndex((g) => g && g.id === giveawayId);
  if (idx === -1) throw new Error("Giveaway tidak ditemukan");

  const g = giveaways[idx];
  if (g.status !== "running") {
    throw new Error("Giveaway sudah tidak aktif");
  }

  if (!Array.isArray(g.participants)) g.participants = [];

  const already = g.participants.includes(discordId);
  if (!already) g.participants.push(discordId);

  giveaways[idx] = g;
  await saveGiveaways(kvClient, giveaways);

  logger.log(
    `[serverv3] joinGiveaway ok id=${giveawayId} user=${discordId} joined=${!already} count=${g.participants.length}`
  );

  return {
    giveaway:         g,
    joined:           !already,
    participantsCount: g.participants.length
  };
}

// Nama fungsi tetap dipakai oleh bot, tapi tidak generate paid key lagi.
async function endGiveawayAndGenerateKeys(opts) {
  const kvClient = opts.kvClient || defaultKv;
  const logger   = opts.logger || console;

  const giveawayId = String(opts.giveawayId || "").trim();
  if (!giveawayId) {
    throw new Error("endGiveawayAndGenerateKeys: giveawayId kosong");
  }

  const giveaways = await loadGiveaways(kvClient, logger);
  const idx       = giveaways.findIndex((g) => g && g.id === giveawayId);
  if (idx === -1) throw new Error("Giveaway tidak ditemukan");

  const g = giveaways[idx];

  if (g.status === "cancelled") {
    throw new Error("Giveaway sudah dibatalkan");
  }

  if (g.status === "ended" && Array.isArray(g.winners) && g.winners.length > 0) {
    return {
      giveaway:    g,
      winners:     g.winners,
      newlyCreated: false
    };
  }

  const participants = Array.isArray(g.participants) ? [...g.participants] : [];
  if (participants.length === 0) {
    g.status    = "ended";
    g.winners   = [];
    g.endedAtIso = nowIso();
    giveaways[idx] = g;
    await saveGiveaways(kvClient, giveaways);

    logger.log(
      `[serverv3] endGiveaway id=${giveawayId} tanpa peserta (winners=0)`
    );

    return {
      giveaway:    g,
      winners:     [],
      newlyCreated: false
    };
  }

  const winnersCount =
    g.winnersCount && g.winnersCount > 0 ? g.winnersCount : 1;
  const pickCount = Math.min(winnersCount, participants.length);

  for (let i = participants.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [participants[i], participants[j]] = [participants[j], participants[i]];
  }

  const selectedIds = participants.slice(0, pickCount);

  const winnersRecords = selectedIds.map((winnerId) => ({
    discordId: winnerId
  }));

  g.status    = "ended";
  g.winners   = winnersRecords;
  g.endedAtIso = nowIso();
  giveaways[idx] = g;
  await saveGiveaways(kvClient, giveaways);

  logger.log(
    `[serverv3] endGiveaway id=${giveawayId} winners=${winnersRecords.length}`
  );

  return {
    giveaway:    g,
    winners:     winnersRecords,
    newlyCreated: true
  };
}

// ============================================================================
// Registrasi route ke Express
// ============================================================================

function registerDiscordBulkDeleteRoutes(app, options = {}) {
  const kvClient       = options.kv || defaultKv;
  const requireAdmin   = options.requireAdmin   || ((req, res, next) => next());
  const requireBotAuth = options.requireBotAuth || ((req, res, next) => next());
  const logger         = options.logger || console;

  if (!app) {
    throw new Error("[serverv3] registerDiscordBulkDeleteRoutes: app tidak terdefinisi");
  }

  // Bulk delete semua data user Discord
  app.post("/admin/discord/bulk-delete-users", requireAdmin, async (req, res) => {
    try {
      let discordIds =
        req.body.discordIds ||
        req.body["discordIds[]"] ||
        req.body.selectedDiscordIds ||
        req.body["selectedDiscordIds[]"] ||
        req.body.userIds ||
        req.body["userIds[]"] ||
        [];

      logger.log("[serverv3] bulk-delete-users raw body:", req.body);
      logger.log("[serverv3] bulk-delete-users raw discordIds:", discordIds);

      if (!Array.isArray(discordIds)) {
        discordIds = [discordIds];
      }

      const normalized = Array.from(
        new Set(
          discordIds
            .map((id) => String(id || "").trim())
            .filter((id) => !!id)
        )
      );

      logger.log("[serverv3] bulk-delete-users normalized IDs:", normalized);

      if (normalized.length === 0) {
        return res.redirect("/admin/discord?bulkDelete=0&msg=NoUserSelected");
      }

      const results = [];
      for (const id of normalized) {
        try {
          const result = await deleteDiscordUserData({
            discordId: id,
            kvClient,
            logger
          });
          results.push(result);
        } catch (errInner) {
          logger.error("[serverv3] Error deleteDiscordUserData untuk", id, errInner);
        }
      }

      const totalUsers   = results.length;
      const totalKeys    = results.reduce((acc, r) => acc + (r.removedKeys || 0), 0);
      const totalExec    = results.reduce((acc, r) => acc + (r.removedExecEntries || 0), 0);
      const totalProfile = results.reduce((acc, r) => acc + (r.removedProfile ? 1 : 0), 0);

      logger.log(
        `[serverv3] Bulk delete selesai. Users=${totalUsers}, Keys=${totalKeys}, ExecEntries=${totalExec}, ProfilesRemoved=${totalProfile}`
      );

      const query =
        `bulkDelete=${totalUsers}` +
        `&bulkDeleteKeys=${totalKeys}` +
        `&bulkDeleteExec=${totalExec}` +
        `&bulkDeleteProfiles=${totalProfile}`;

      return res.redirect("/admin/discord?" + query);
    } catch (err) {
      logger.error("[serverv3] bulk-delete-users error:", err);
      return res
        .status(500)
        .send("Error while bulk deleting Discord users. Check server logs.");
    }
  });

  // Manual generate paid key via Admin Panel
  app.post("/admin/discord/generate-paid-key", requireAdmin, async (req, res) => {
    try {
      const discordId = String(req.body.discordId || "").trim();
      let plan        = String(req.body.plan || "month").toLowerCase().trim();

      if (!discordId) {
        return res.redirect("/admin/discord?msg=MissingDiscordId");
      }

      const result = await generatePaidKeyForDiscordUser({
        discordId,
        plan,
        kvClient,
        logger
      });

      const params = new URLSearchParams();
      params.set("user",           discordId);
      params.set("generated",      "1");
      params.set("generatedPlan",  result.plan);
      params.set("generatedToken", result.token);

      return res.redirect("/admin/discord?" + params.toString());
    } catch (err) {
      logger.error("[serverv3] generate-paid-key error:", err);
      return res
        .status(500)
        .send("Error while generating paid key. Check server logs.");
    }
  });

  // API untuk bot Discord – create giveaway
  app.post("/api/bot/giveaway/create", requireBotAuth, async (req, res) => {
    try {
      const body = req.body || {};

      const giveaway = await createGiveawayRecord({
        kvClient,
        logger,
        guildId:            body.guildId,
        channelId:          body.channelId,
        messageId:          body.messageId,
        createdByDiscordId: body.createdByDiscordId,
        durationMs:         body.durationMs,
        durationSeconds:    body.durationSeconds,
        durationMinutes:    body.durationMinutes,
        winnersCount:       body.winnersCount,
        numberOfWinners:    body.numberOfWinners,
        prize:              body.prize,
        description:        body.description,
        plan:               body.plan
      });

      const sanitized = sanitizeGiveawayForPublic(giveaway);

      return res.json({
        ok:       true,
        giveaway: sanitized,
        summaryUrl: giveaway.summaryUrl
      });
    } catch (err) {
      logger.error("[serverv3] /api/bot/giveaway/create error:", err);
      return res.status(500).json({
        ok:    false,
        error: "create-failed",
        message: String((err && err.message) || err)
      });
    }
  });

  // API – join giveaway
  app.post("/api/bot/giveaway/join", requireBotAuth, async (req, res) => {
    try {
      const body       = req.body || {};
      const giveawayId = body.giveawayId || body.id;
      const discordId  = body.discordId;

      const result = await joinGiveaway({
        kvClient,
        logger,
        giveawayId,
        discordId
      });

      const sanitized = sanitizeGiveawayForPublic(result.giveaway);

      return res.json({
        ok:       true,
        giveaway: sanitized,
        joined:   result.joined,
        participantsCount: result.participantsCount
      });
    } catch (err) {
      logger.error("[serverv3] /api/bot/giveaway/join error:", err);
      return res.status(500).json({
        ok:    false,
        error: "join-failed",
        message: String((err && err.message) || err)
      });
    }
  });

  // API – end giveaway (tanpa auto generate key)
  app.post("/api/bot/giveaway/end", requireBotAuth, async (req, res) => {
    try {
      const body       = req.body || {};
      const giveawayId = body.giveawayId || body.id;

      const result = await endGiveawayAndGenerateKeys({
        kvClient,
        logger,
        giveawayId
      });

      const sanitized = sanitizeGiveawayForPublic(result.giveaway);

      return res.json({
        ok:       true,
        giveawayId,
        status:   result.giveaway.status,
        winners:  result.winners,
        giveaway: sanitized
      });
    } catch (err) {
      logger.error("[serverv3] /api/bot/giveaway/end error:", err);
      return res.status(500).json({
        ok:    false,
        error: "end-failed",
        message: String((err && err.message) || err)
      });
    }
  });

  // API – get detail giveaway
  app.get("/api/bot/giveaway/:id", requireBotAuth, async (req, res) => {
    try {
      const id        = String(req.params.id || "").trim();
      const giveaways = await loadGiveaways(kvClient, logger);
      const g         = giveaways.find((item) => item && item.id === id);

      if (!g) {
        return res.status(404).json({
          ok:    false,
          error: "not-found"
        });
      }

      const sanitized = sanitizeGiveawayForPublic(g);

      return res.json({
        ok:       true,
        giveaway: sanitized
      });
    } catch (err) {
      logger.error("[serverv3] /api/bot/giveaway/:id error:", err);
      return res.status(500).json({
        ok:    false,
        error: "detail-failed",
        message: String((err && err.message) || err)
      });
    }
  });

  // Web summary: /summary/ga/:id (sinkron dengan SUMMARY_BASE_URL)
  app.get("/summary/ga/:id", async (req, res) => {
    try {
      const id        = String(req.params.id || "").trim();
      const giveaways = await loadGiveaways(kvClient, logger);
      const g         = giveaways.find((item) => item && item.id === id);

      if (!g) {
        return res.status(404).render("discord-giveaway-summary", {
          title:    "Giveaway not found",
          giveaway: null
        });
      }

      const sanitized = sanitizeGiveawayForPublic(g);

      return res.render("discord-giveaway-summary", {
        title: g.prize ? `Discord Giveaway – ${g.prize}` : "Discord Giveaway",
        giveaway: sanitized
      });
    } catch (err) {
      logger.error("[serverv3] /summary/ga/:id error:", err);
      return res
        .status(500)
        .send("Internal error while rendering giveaway summary.");
    }
  });
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  registerDiscordBulkDeleteRoutes,
  deleteDiscordUserData,
  generatePaidKeyForDiscordUser,
  createGiveawayRecord,
  joinGiveaway,
  endGiveawayAndGenerateKeys,
  SUMMARY_BASE_URL
};
