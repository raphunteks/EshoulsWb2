//==========================================================
//  serverv3.js
//  Modul tambahan untuk Admin Discord:
//  - Bulk delete per Discord user (by discordId)
//  - Menghapus: key (redeemed → deleted), exec-users, profil Discord
//==========================================================

"use strict";

const fs   = require("fs");
const path = require("path");

// Opsional: kalau kamu mau inject kv dari luar, boleh lewat options.
// Di sini tetap sediakan fallback require.
let defaultKv = null;
try {
  // Sesuaikan dengan cara kamu import Upstash di server utama.
  // Misal: const { kv } = require("@vercel/kv");
  const kvModule = require("@vercel/kv");
  defaultKv = kvModule.kv || kvModule.default || null;
} catch (err) {
  // Jika tidak pakai @vercel/kv, biarkan null (hanya gunakan file JSON lokal).
  defaultKv = null;
}

//================== KONFIGURASI STORE ==================//

// Folder data lokal (samakan dengan yang kamu pakai di server.js / serverv2.js)
const DATA_DIR = path.join(__dirname, "data");

// File JSON lokal fallback
const FILE_REDEEMED_KEYS = path.join(DATA_DIR, "redeemed-keys.json");
const FILE_DELETED_KEYS  = path.join(DATA_DIR, "deleted-keys.json");
const FILE_EXEC_USERS    = path.join(DATA_DIR, "exec-users.json");
const FILE_DISCORD_USERS = path.join(DATA_DIR, "discord-users.json"); // sesuaikan

// Nama key di Upstash KV (samakan dengan yang kamu pakai sekarang)
const KV_REDEEMED_KEYS_KEY = "exhub:redeemed-keys";
const KV_DELETED_KEYS_KEY  = "exhub:deleted-keys";
const KV_EXEC_USERS_KEY    = "exhub:exec-users";
const KV_DISCORD_USERS_KEY = "exhub:discord-users"; // atau "exhub:discord:users" kalau itu yang kamu pakai

//==========================================================
//  Helper: baca / tulis JSON lokal (fallback)
//==========================================================

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

//==========================================================
//  Helper: load / save store dengan prioritas KV → file lokal
//==========================================================

async function loadStore({ kvClient, kvKey, filePath, defaultValue }) {
  // 1) Coba dari KV
  if (kvClient) {
    try {
      const value = await kvClient.get(kvKey);
      if (value != null) {
        return value;
      }
    } catch (err) {
      console.error("[serverv3] loadStore KV error:", kvKey, err);
    }
  }

  // 2) Fallback ke file lokal
  return readJsonFileSafe(filePath, defaultValue);
}

async function saveStore({ kvClient, kvKey, filePath, value }) {
  // 1) Tulis ke KV
  if (kvClient) {
    try {
      await kvClient.set(kvKey, value);
    } catch (err) {
      console.error("[serverv3] saveStore KV error:", kvKey, err);
    }
  }

  // 2) Tulis ke file lokal
  writeJsonFileSafe(filePath, value);
}

//==========================================================
//  Core: hapus semua data milik 1 discordId
//==========================================================

/**
 * Menghapus semua data milik 1 Discord user:
 * - Keys di redeemed-keys (dipindah ke deleted-keys dengan metadata alasan).
 * - Data exec di exec-users untuk setiap key token.
 * - Profil Discord user di discord-users.
 *
 * @param {Object} opts
 * @param {string} opts.discordId
 * @param {Object} opts.kvClient
 * @param {Function} [opts.logger]
 * @returns {Promise<{discordId: string, removedKeys: number, removedExecEntries: number, removedProfile: boolean}>}
 */
async function deleteDiscordUserData(opts) {
  const discordId = String(opts.discordId || "").trim();
  const kvClient  = opts.kvClient || defaultKv;
  const logger    = opts.logger || console;

  if (!discordId) {
    throw new Error("deleteDiscordUserData: discordId kosong");
  }

  logger.log(`[serverv3] Delete data untuk Discord ID: ${discordId}`);

  // 1) Load store utama
  let redeemedKeys = await loadStore({
    kvClient,
    kvKey: KV_REDEEMED_KEYS_KEY,
    filePath: FILE_REDEEMED_KEYS,
    defaultValue: []
  });

  if (!Array.isArray(redeemedKeys)) redeemedKeys = [];

  let deletedKeys = await loadStore({
    kvClient,
    kvKey: KV_DELETED_KEYS_KEY,
    filePath: FILE_DELETED_KEYS,
    defaultValue: []
  });
  if (!Array.isArray(deletedKeys)) deletedKeys = [];

  let execUsers = await loadStore({
    kvClient,
    kvKey: KV_EXEC_USERS_KEY,
    filePath: FILE_EXEC_USERS,
    defaultValue: {}
  });
  if (!execUsers || typeof execUsers !== "object") execUsers = {};

  let discordUsers = await loadStore({
    kvClient,
    kvKey: KV_DISCORD_USERS_KEY,
    filePath: FILE_DISCORD_USERS,
    defaultValue: {}
  });
  if (!discordUsers || typeof discordUsers !== "object") discordUsers = {};

  // 2) Filter redeemed-keys dan kumpulkan token yang akan dihapus
  const nowIso = new Date().toISOString();

  const keysToKeep = [];
  const keysToDelete = [];

  for (const item of redeemedKeys) {
    if (!item) continue;
    const itemDiscordId = String(item.discordId || "").trim();
    if (itemDiscordId === discordId) {
      keysToDelete.push(item);
    } else {
      keysToKeep.push(item);
    }
  }

  // 3) Update redeemed-keys (hapus key milik user ini)
  redeemedKeys = keysToKeep;

  // 4) Tambahkan ke deleted-keys dengan metadata alasan penghapusan
  if (keysToDelete.length > 0) {
    const mappedDeleted = keysToDelete.map((item) => {
      const copy = Object.assign({}, item);
      copy.deletedAt = nowIso;
      copy.deleteReason = "discord-user-delete";
      copy.deleteByDiscordId = discordId;
      return copy;
    });
    deletedKeys = deletedKeys.concat(mappedDeleted);
  }

  // 5) Hapus entry exec-users per key token pengguna ini
  let removedExecEntries = 0;
  for (const item of keysToDelete) {
    const token = String(item.token || item.key || "").trim();
    if (!token) continue;
    if (execUsers[token]) {
      delete execUsers[token];
      removedExecEntries++;
    }
  }

  // 6) Hapus profil Discord user
  let removedProfile = false;
  if (discordUsers[discordId]) {
    delete discordUsers[discordId];
    removedProfile = true;
  }

  // 7) Simpan kembali semua store
  await saveStore({
    kvClient,
    kvKey: KV_REDEEMED_KEYS_KEY,
    filePath: FILE_REDEEMED_KEYS,
    value: redeemedKeys
  });

  await saveStore({
    kvClient,
    kvKey: KV_DELETED_KEYS_KEY,
    filePath: FILE_DELETED_KEYS,
    value: deletedKeys
  });

  await saveStore({
    kvClient,
    kvKey: KV_EXEC_USERS_KEY,
    filePath: FILE_EXEC_USERS,
    value: execUsers
  });

  await saveStore({
    kvClient,
    kvKey: KV_DISCORD_USERS_KEY,
    filePath: FILE_DISCORD_USERS,
    value: discordUsers
  });

  logger.log(
    `[serverv3] Discord ID ${discordId} → removed keys=${keysToDelete.length}, execEntries=${removedExecEntries}, profileRemoved=${removedProfile}`
  );

  return {
    discordId,
    removedKeys: keysToDelete.length,
    removedExecEntries,
    removedProfile
  };
}

//==========================================================
//  Registrasi route ke Express app
//==========================================================

/**
 * Register route bulk delete Discord users ke Express app.
 *
 * @param {import('express').Express} app
 * @param {Object} [options]
 * @param {Object} [options.kv]                  - client Upstash KV (opsional, jika tidak diisi pakai defaultKv di atas)
 * @param {Function} [options.requireAdmin]      - middleware proteksi admin (misal ensureAdminSession)
 * @param {Function} [options.logger]            - logger custom (default console)
 */
function registerDiscordBulkDeleteRoutes(app, options = {}) {
  const kvClient      = options.kv || defaultKv;
  const requireAdmin  = options.requireAdmin || ((req, res, next) => next());
  const logger        = options.logger || console;

  // Route untuk handle form checkbox di admin-dashboarddiscord.ejs
  // Method: POST
  // Path:   /admin/discord/bulk-delete-users
  // Body:   discordIds (bisa string atau array)
  app.post("/admin/discord/bulk-delete-users", requireAdmin, async (req, res) => {
    try {
      let discordIds = req.body.discordIds || req.body["discordIds[]"] || [];

      // Normalisasi ke array
      if (!Array.isArray(discordIds)) {
        discordIds = [discordIds];
      }

      // Bersihkan duplikat dan kosong
      const normalized = Array.from(
        new Set(
          discordIds
            .map((id) => String(id || "").trim())
            .filter((id) => !!id)
        )
      );

      if (normalized.length === 0) {
        // Tidak ada yang dipilih
        return res.redirect("/admin/discord?bulkDelete=0&msg=NoUserSelected");
      }

      const results = [];
      for (const discordId of normalized) {
        try {
          const result = await deleteDiscordUserData({
            discordId,
            kvClient,
            logger
          });
          results.push(result);
        } catch (errInner) {
          logger.error(
            "[serverv3] Error deleteDiscordUserData untuk",
            discordId,
            errInner
          );
        }
      }

      const totalUsers   = results.length;
      const totalKeys    = results.reduce((acc, r) => acc + (r.removedKeys || 0), 0);
      const totalExec    = results.reduce((acc, r) => acc + (r.removedExecEntries || 0), 0);
      const totalProfile = results.reduce(
        (acc, r) => acc + (r.removedProfile ? 1 : 0),
        0
      );

      logger.log(
        `[serverv3] Bulk delete selesai. Users=${totalUsers}, Keys=${totalKeys}, ExecEntries=${totalExec}, ProfilesRemoved=${totalProfile}`
      );

      // Redirect kembali ke halaman admin discord dengan query info
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
}

//==========================================================
//  Exports
//==========================================================

module.exports = {
  registerDiscordBulkDeleteRoutes,
  deleteDiscordUserData
};