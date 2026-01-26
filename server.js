// server.js
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const cookieSession = require('cookie-session');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const PROCESS_START_TIME = Date.now();

// ======================================================
// Multer (upload script/ raw file)
// ======================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

// ======================================================
// Upstash / KV helpers
// ======================================================

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const hasKV = !!(KV_URL && KV_TOKEN);

async function kvRequest(pathPart) {
  if (!hasKV || typeof fetch === 'undefined') return null;

  const url = `${KV_URL}/${pathPart}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('KV error', res.status, text);
      return null;
    }

    const data = await res.json().catch(() => null);
    if (data && Object.prototype.hasOwnProperty.call(data, 'result')) {
      return data.result;
    }
    return null;
  } catch (err) {
    console.error('KV request failed:', err);
    return null;
  }
}

function kvPath(cmd, ...segments) {
  const encoded = segments.map((s) => encodeURIComponent(String(s)));
  return `${cmd}/${encoded.join('/')}`;
}

async function kvGet(key) {
  return kvRequest(kvPath('GET', key));
}
async function kvSet(key, value) {
  return kvRequest(kvPath('SET', key, value));
}
async function kvIncr(key) {
  return kvRequest(kvPath('INCR', key));
}
async function kvSAdd(key, member) {
  return kvRequest(kvPath('SADD', key, member));
}
async function kvSCard(key) {
  return kvRequest(kvPath('SCARD', key));
}
async function kvSMembers(key) {
  return kvRequest(kvPath('SMEMBERS', key));
}
async function kvSRem(key, member) {
  return kvRequest(kvPath('SREM', key, member));
}
async function kvDel(key) {
  return kvRequest(kvPath('DEL', key));
}

async function kvGetInt(key) {
  const result = await kvGet(key);
  if (result == null) return 0;
  const n = parseInt(result, 10);
  return Number.isNaN(n) ? 0 : n;
}

// ======================================================
// Paths & KV keys
// ======================================================

const CONFIG_DIR = path.join(__dirname, 'config');

const SCRIPTS_PATH = path.join(CONFIG_DIR, 'scripts.json');
const REDEEMED_PATH = path.join(CONFIG_DIR, 'redeemed-keys.json');
const DELETED_PATH = path.join(CONFIG_DIR, 'deleted-keys.json');
const EXEC_USERS_PATH = path.join(CONFIG_DIR, 'exec-users.json');
const RAW_FILES_PATH = path.join(CONFIG_DIR, 'raw-files.json');
const SITE_CONFIG_PATH = path.join(CONFIG_DIR, 'site-config.json');
const WEB_KEYS_PATH = path.join(CONFIG_DIR, 'web-keys.json');

const SCRIPTS_RAW_DIR = path.join(__dirname, 'scripts-raw');
const RAW_FILES_DIR = path.join(__dirname, 'private-raw');

const KV_SCRIPTS_META_KEY = 'exhub:scripts-meta';
const KV_REDEEMED_KEY = 'exhub:redeemed-keys';
const KV_DELETED_KEYS_KEY = 'exhub:deleted-keys';

const KV_EXEC_USERS_KEY = 'exhub:exec-users';
const KV_EXEC_ENTRY_PREFIX = 'exhub:exec-user:';
const KV_EXEC_INDEX_KEY = 'exhub:exec-users:index';

const KV_SCRIPT_BODY_PREFIX = 'exhub:script-body:';

const KV_RAW_FILES_META_KEY = 'exhub:raw-files-meta';
const KV_RAW_BODY_PREFIX = 'exhub:raw-body:';

const KV_SITE_CONFIG_KEY = 'exhub:site-config';
const KV_WEB_KEYS_KEY = 'exhub:web-keys';

// generatekey (lama, hanya untuk admin key manager)
const MAX_KEYS_PER_IP = parseInt(process.env.MAX_KEYS_PER_IP || '10', 10);
const DEFAULT_KEY_HOURS = parseInt(process.env.DEFAULT_KEY_HOURS || '24', 10);

// ======================================================
// Small helpers
// ======================================================

function getClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
}

function isRobloxUserAgent(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  return ua.includes('roblox');
}

function safeScriptFileName(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureScriptsRawDir() {
  try {
    if (!fs.existsSync(SCRIPTS_RAW_DIR)) {
      fs.mkdirSync(SCRIPTS_RAW_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('ensureScriptsRawDir error:', err);
  }
}

function ensureRawFilesDir() {
  try {
    if (!fs.existsSync(RAW_FILES_DIR)) {
      fs.mkdirSync(RAW_FILES_DIR, { recursive: true });
    }
  } catch (err) {
    console.error('ensureRawFilesDir error:', err);
  }
}

// helper umum: baca body dari textarea + upload file (tanpa mengubah konten)
function extractBodyFromReq(req, textFieldName) {
  const rawText =
    typeof req.body[textFieldName] === 'string' ? req.body[textFieldName] : '';
  const text = rawText.trim() === '' ? null : rawText;

  let uploaded = null;
  if (req.file && req.file.buffer && req.file.size > 0) {
    uploaded = req.file.buffer.toString('utf8');
  }

  if (uploaded != null) return uploaded;
  if (text != null) return rawText;
  return null;
}

// ======================================================
// Local JSON file helpers (fallback dev / non-KV)
// ======================================================

function loadJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load JSON file', filePath, err);
    return fallback;
  }
}

function saveJsonFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save JSON file', filePath, err);
  }
}

// scripts meta
function loadScriptsFromFile() {
  return loadJsonFile(SCRIPTS_PATH, []);
}
function saveScriptsToFile(scripts) {
  saveJsonFile(SCRIPTS_PATH, scripts);
}

// redeemed keys (lama)
function loadRedeemedFromFile() {
  return loadJsonFile(REDEEMED_PATH, []);
}
function saveRedeemedToFile(list) {
  saveJsonFile(REDEEMED_PATH, list);
}

// deleted keys
function loadDeletedFromFile() {
  const val = loadJsonFile(DELETED_PATH, []);
  return Array.isArray(val) ? val : [];
}
function saveDeletedToFile(list) {
  saveJsonFile(DELETED_PATH, list);
}

// exec-users
function loadExecUsersFromFile() {
  return loadJsonFile(EXEC_USERS_PATH, []);
}
function saveExecUsersToFile(list) {
  saveJsonFile(EXEC_USERS_PATH, list);
}

// raw-files meta
function loadRawFilesFromFile() {
  return loadJsonFile(RAW_FILES_PATH, []);
}
function saveRawFilesToFile(list) {
  saveJsonFile(RAW_FILES_PATH, list);
}

// site-config
function loadSiteConfigFromFile() {
  const cfg = loadJsonFile(SITE_CONFIG_PATH, {});
  return cfg && typeof cfg === 'object' ? cfg : {};
}
function saveSiteConfigToFile(cfg) {
  saveJsonFile(SITE_CONFIG_PATH, cfg);
}

// web-keys
function loadWebKeysFromFile() {
  const arr = loadJsonFile(WEB_KEYS_PATH, []);
  return Array.isArray(arr) ? arr : [];
}
function saveWebKeysToFile(list) {
  saveJsonFile(WEB_KEYS_PATH, list);
}

// ======================================================
// load/save via KV + file
// ======================================================

// scripts meta
async function loadScripts() {
  if (hasKV) {
    const raw = await kvGet(KV_SCRIPTS_META_KEY);
    if (raw && typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        console.error('Failed to parse scripts meta from KV:', e);
      }
    }
    const seeded = loadScriptsFromFile();
    try {
      await kvSet(KV_SCRIPTS_META_KEY, JSON.stringify(seeded));
    } catch (e) {
      console.error('Failed to seed scripts meta to KV:', e);
    }
    return seeded;
  }
  return loadScriptsFromFile();
}

async function saveScripts(scripts) {
  const json = JSON.stringify(scripts);
  if (hasKV) {
    try {
      await kvSet(KV_SCRIPTS_META_KEY, json);
    } catch (e) {
      console.error('Failed to save scripts meta to KV:', e);
    }
  }
  saveScriptsToFile(scripts);
}

// redeemed keys
async function loadRedeemedKeys() {
  if (hasKV) {
    const raw = await kvGet(KV_REDEEMED_KEY);
    if (raw && typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        console.error('Failed to parse redeemed keys from KV:', e);
      }
    }
  }
  return loadRedeemedFromFile();
}

async function saveRedeemedKeys(list) {
  const json = JSON.stringify(list);
  if (hasKV) {
    try {
      await kvSet(KV_REDEEMED_KEY, json);
    } catch (e) {
      console.error('Failed to save redeemed keys to KV:', e);
    }
  }
  saveRedeemedToFile(list);
}

// deleted keys
async function loadDeletedKeys() {
  if (hasKV) {
    try {
      const raw = await kvGet(KV_DELETED_KEYS_KEY);
      if (raw && typeof raw === 'string') {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.error('Failed to load deleted keys from KV:', err);
    }
  }
  return loadDeletedFromFile();
}

async function saveDeletedKeys(list) {
  const json = JSON.stringify(list);
  if (hasKV) {
    try {
      await kvSet(KV_DELETED_KEYS_KEY, json);
    } catch (err) {
      console.error('Failed to save deleted keys to KV:', err);
    }
  }
  saveDeletedToFile(list);
}

// exec-users
async function loadExecUsers() {
  if (hasKV) {
    try {
      const index = await kvSMembers(KV_EXEC_INDEX_KEY);
      if (Array.isArray(index) && index.length > 0) {
        const results = [];
        for (const entryKey of index) {
          if (!entryKey) continue;
          const raw = await kvGet(KV_EXEC_ENTRY_PREFIX + entryKey);
          if (!raw || typeof raw !== 'string' || raw === '') continue;
          try {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') {
              obj.key = obj.key || entryKey;
              results.push(obj);
            }
          } catch (e) {
            console.error(
              'Failed to parse exec-user from KV for key',
              entryKey,
              e
            );
          }
        }
        if (results.length) return results;
      }
    } catch (err) {
      console.error('Failed to load exec-users from KV index:', err);
    }

    try {
      const rawLegacy = await kvGet(KV_EXEC_USERS_KEY);
      if (rawLegacy && typeof rawLegacy === 'string') {
        const parsed = JSON.parse(rawLegacy);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.error('Failed to load legacy exec-users from KV:', e);
    }
  }
  return loadExecUsersFromFile();
}

async function saveExecUsers(list) {
  const json = JSON.stringify(list);
  if (hasKV) {
    try {
      await kvSet(KV_EXEC_USERS_KEY, json);
    } catch (e) {
      console.error('Failed to save exec-users to KV:', e);
    }
  }
  saveExecUsersToFile(list);
}

// raw-files meta
async function loadRawFiles() {
  if (hasKV) {
    const raw = await kvGet(KV_RAW_FILES_META_KEY);
    if (raw && typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        console.error('Failed to parse raw-files from KV:', e);
      }
    }
    const seeded = loadRawFilesFromFile();
    try {
      await kvSet(KV_RAW_FILES_META_KEY, JSON.stringify(seeded));
    } catch (e) {
      console.error('Failed to seed raw-files to KV:', e);
    }
    return seeded;
  }
  return loadRawFilesFromFile();
}

async function saveRawFiles(list) {
  const json = JSON.stringify(list);
  if (hasKV) {
    try {
      await kvSet(KV_RAW_FILES_META_KEY, json);
    } catch (e) {
      console.error('Failed to save raw-files to KV:', e);
    }
  }
  saveRawFilesToFile(list);
}

// site-config
async function loadSiteConfig() {
  const base = {
    defaultKeyHours: DEFAULT_KEY_HOURS,
    maxKeysPerIp: MAX_KEYS_PER_IP
  };

  if (hasKV) {
    try {
      const raw = await kvGet(KV_SITE_CONFIG_KEY);
      if (raw && typeof raw === 'string') {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return { ...base, ...parsed };
        }
      }
    } catch (err) {
      console.error('Failed to load site-config from KV:', err);
    }
  }

  const fileCfg = loadSiteConfigFromFile();
  const merged = { ...base, ...fileCfg };

  if (hasKV) {
    try {
      await kvSet(KV_SITE_CONFIG_KEY, JSON.stringify(merged));
    } catch (err) {
      console.error('Failed to seed site-config to KV:', err);
    }
  }

  return merged;
}

async function saveSiteConfig(cfg) {
  const merged = {
    defaultKeyHours: Number.isFinite(cfg.defaultKeyHours)
      ? cfg.defaultKeyHours
      : DEFAULT_KEY_HOURS,
    maxKeysPerIp: Number.isFinite(cfg.maxKeysPerIp)
      ? cfg.maxKeysPerIp
      : MAX_KEYS_PER_IP
  };

  const json = JSON.stringify(merged);
  if (hasKV) {
    try {
      await kvSet(KV_SITE_CONFIG_KEY, json);
    } catch (err) {
      console.error('Failed to save site-config to KV:', err);
    }
  }
  saveSiteConfigToFile(merged);
}

// web-keys (generatekey system lama, dipakai admin /api/isValidate)
async function loadWebKeys() {
  if (hasKV) {
    try {
      const raw = await kvGet(KV_WEB_KEYS_KEY);
      if (raw && typeof raw === 'string') {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.error('Failed to load web-keys from KV:', err);
    }
  }
  return loadWebKeysFromFile();
}

async function saveWebKeys(list) {
  const json = JSON.stringify(list);
  if (hasKV) {
    try {
      await kvSet(KV_WEB_KEYS_KEY, json);
    } catch (err) {
      console.error('Failed to save web-keys to KV:', err);
    }
  }
  saveWebKeysToFile(list);
}

// ======================================================
// Script body (raw Lua) load/save
// ======================================================

async function loadScriptBody(script) {
  if (!script || !script.id) return null;

  // 1) KV (pure string, tidak lewat JSON)
  if (hasKV) {
    try {
      const kvKey = KV_SCRIPT_BODY_PREFIX + String(script.id);
      const raw = await kvGet(kvKey);
      if (raw && typeof raw === 'string' && raw !== '') {
        return raw;
      }
    } catch (err) {
      console.error('Failed to load script body from KV:', err);
    }
  }

  // 2) Local file scripts-raw/<id>.lua
  try {
    ensureScriptsRawDir();
    const fileName = safeScriptFileName(script.id) + '.lua';
    const localPath = path.join(SCRIPTS_RAW_DIR, fileName);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath, 'utf8');
    }
  } catch (err) {
    console.error('Failed to load script body from local file:', err);
  }

  // 3) Legacy /scripts folder (jika masih digunakan)
  try {
    if (script.scriptFile) {
      const legacyPath = path.join(__dirname, 'scripts', script.scriptFile);
      if (fs.existsSync(legacyPath)) {
        return fs.readFileSync(legacyPath, 'utf8');
      }
    }
  } catch (err) {
    console.error('Failed to load script body from legacy path:', err);
  }

  return null;
}

async function saveScriptBody(scriptId, body) {
  if (!scriptId) return;
  const strBody = String(body ?? '');

  // KV: simpan RAW text, tidak di-wrap JSON
  if (hasKV) {
    try {
      const kvKey = KV_SCRIPT_BODY_PREFIX + String(scriptId);
      await kvSet(kvKey, strBody);
    } catch (err) {
      console.error('Failed to save script body to KV:', err);
    }
  }

  // Local file
  try {
    ensureScriptsRawDir();
    const fileName = safeScriptFileName(scriptId) + '.lua';
    const localPath = path.join(SCRIPTS_RAW_DIR, fileName);
    fs.writeFileSync(localPath, strBody, 'utf8');
  } catch (err) {
    console.error('Failed to save script body to local file:', err);
  }
}

// CLEAR script body (dipakai untuk "Clear Script Body" & delete)
async function removeScriptBody(scriptId) {
  if (!scriptId) return;

  // Clear KV
  if (hasKV) {
    try {
      const kvKey = KV_SCRIPT_BODY_PREFIX + String(scriptId);
      await kvSet(kvKey, '');
    } catch (err) {
      console.error('Failed to clear script body from KV:', err);
    }
  }

  // Hapus file lokal
  try {
    ensureScriptsRawDir();
    const fileName = safeScriptFileName(scriptId) + '.lua';
    const localPath = path.join(SCRIPTS_RAW_DIR, fileName);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  } catch (err) {
    console.error('Failed to remove script body local file:', err);
  }
}

// ======================================================
// Raw-body untuk Private Raw Files
// ======================================================

async function loadRawBody(rawId) {
  if (!rawId) return null;

  if (hasKV) {
    try {
      const kvKey = KV_RAW_BODY_PREFIX + String(rawId);
      const raw = await kvGet(kvKey);
      if (raw && typeof raw === 'string' && raw !== '') {
        return raw;
      }
    } catch (err) {
      console.error('Failed to load raw body from KV:', err);
    }
  }

  try {
    ensureRawFilesDir();
    const base = safeScriptFileName(rawId);
    const exts = ['.lua', '.txt', '.raw'];
    for (const ext of exts) {
      const filePath = path.join(RAW_FILES_DIR, base + ext);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    }
  } catch (err) {
    console.error('Failed to load raw body from local file:', err);
  }

  return null;
}

async function saveRawBody(rawId, body) {
  if (!rawId) return;
  const strBody = String(body ?? '');

  if (hasKV) {
    try {
      const kvKey = KV_RAW_BODY_PREFIX + String(rawId);
      await kvSet(kvKey, strBody);
    } catch (err) {
      console.error('Failed to save raw body to KV:', err);
    }
  }

  try {
    ensureRawFilesDir();
    const base = safeScriptFileName(rawId);
    const filePath = path.join(RAW_FILES_DIR, base + '.lua');
    fs.writeFileSync(filePath, strBody, 'utf8');
  } catch (err) {
    console.error('Failed to save raw body to local file:', err);
  }
}

async function removeRawBody(rawId) {
  if (!rawId) return;

  if (hasKV) {
    try {
      const kvKey = KV_RAW_BODY_PREFIX + String(rawId);
      await kvSet(kvKey, '');
    } catch (err) {
      console.error('Failed to clear raw body from KV:', err);
    }
  }

  try {
    ensureRawFilesDir();
    const base = safeScriptFileName(rawId);
    ['.lua', '.txt', '.raw'].forEach((ext) => {
      const filePath = path.join(RAW_FILES_DIR, base + ext);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (err) {
    console.error('Failed to remove raw body local file:', err);
  }
}

// ======================================================
// Time / stats helpers
// ======================================================

function formatTimeLeft(diffMs) {
  if (diffMs == null || diffMs <= 0) return 'Expired';
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

const DATE_TIME_FORMAT_OPTIONS_TZ = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
};

function formatDualTimeLabelMs(ms) {
  if (!ms || !Number.isFinite(ms)) return '-';
  try {
    const date = new Date(ms);

    const fmtWIB = new Intl.DateTimeFormat('id-ID', {
      ...DATE_TIME_FORMAT_OPTIONS_TZ,
      timeZone: 'Asia/Jakarta'
    });
    const fmtWITA = new Intl.DateTimeFormat('id-ID', {
      ...DATE_TIME_FORMAT_OPTIONS_TZ,
      timeZone: 'Asia/Makassar'
    });

    const wib = fmtWIB.format(date);
    const wita = fmtWITA.format(date);
    return `${wib} WIB / ${wita} WITA`;
  } catch (err) {
    console.error('formatDualTimeLabelMs error:', err);
    return new Date(ms).toLocaleString('id-ID');
  }
}

// HH:MM:SS atau "1h 10m 20s" → now + durasi
function parseRelativeExpiresInput(raw, nowMs) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;

  const hhmmss = str.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (hhmmss) {
    let h = parseInt(hhmmss[1], 10) || 0;
    let m = parseInt(hhmmss[2], 10) || 0;
    let s = parseInt(hhmmss[3], 10) || 0;

    if (h < 0) h = 0;
    if (m < 0) m = 0;
    if (s < 0) s = 0;

    const totalMs = (h * 3600 + m * 60 + s) * 1000;
    if (totalMs <= 0) return null;

    return nowMs + totalMs;
  }

  const re =
    /^\s*(?:(\d+)\s*h(?:hours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?\s*$/i;
  const m2 = str.match(re);
  if (!m2) return null;

  const h2 = m2[1] ? parseInt(m2[1], 10) : 0;
  const min2 = m2[2] ? parseInt(m2[2], 10) : 0;
  const s2 = m2[3] ? parseInt(m2[3], 10) : 0;

  if (Number.isNaN(h2) || Number.isNaN(min2) || Number.isNaN(s2)) return null;

  const totalMs2 = (h2 * 3600 + min2 * 60 + s2) * 1000;
  if (totalMs2 <= 0) return null;

  return nowMs + totalMs2;
}

function computeStats(scripts) {
  const totalGames = scripts.length;
  const totalExecutions = scripts.reduce((acc, s) => acc + (s.uses || 0), 0);
  const totalUsers = scripts.reduce((acc, s) => acc + (s.users || 0), 0);
  return { totalGames, totalExecutions, totalUsers };
}

function getApiUptimeSeconds() {
  const diffMs = Date.now() - PROCESS_START_TIME;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / 1000);
}

// ======================================================
// Scripts + exec stats (Admin Dashboard)
// ======================================================

async function hydrateScriptsWithKV(scripts) {
  if (!hasKV) return scripts;

  await Promise.all(
    scripts.map(async (s) => {
      const baseKey = `exhub:script:${s.id}`;
      s.uses = await kvGetInt(`${baseKey}:uses`);
      s.users = await kvGetInt(`${baseKey}:users`);
    })
  );

  return scripts;
}

async function loadScriptsHydrated() {
  const scripts = await loadScripts();
  return hydrateScriptsWithKV(scripts);
}

async function syncScriptCountersToKV(script) {
  if (!hasKV) return;
  const baseKey = `exhub:script:${script.id}`;
  try {
    await Promise.all([
      kvSet(`${baseKey}:uses`, String(script.uses || 0)),
      kvSet(`${baseKey}:users`, String(script.users || 0))
    ]);
  } catch (e) {
    console.error('syncScriptCountersToKV error:', e);
  }
}

/**
 * period: '24h' | '7d' | '30d' | 'all'
 * options: { withBodyPreview?: boolean }
 */
async function buildAdminStats(period, options = {}) {
  const { withBodyPreview = false } = options || {};

  const now = new Date();
  const MS_24H = 24 * 60 * 60 * 1000;
  const MS_7D = 7 * MS_24H;
  const MS_30D = 30 * MS_24H;

  function parseDateSafe(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function inSelectedPeriod(entry) {
    if (period === 'all' || !period) return true;
    const d = parseDateSafe(entry.lastExecuteAt);
    if (!d) return false;
    const diff = now - d;
    if (diff < 0) return false;
    if (period === '24h') return diff <= MS_24H;
    if (period === '7d') return diff <= MS_7D;
    if (period === '30d') return diff <= MS_30D;
    return true;
  }

  let scripts = await loadScriptsHydrated();

  // Tambahan: isi flag hasBody + bodyPreview untuk admin-dashboard.ejs
  if (withBodyPreview) {
    const maxPreviewLength = 512;
    await Promise.all(
      scripts.map(async (s) => {
        s.hasBody = false;
        s.bodyPreview = '';
        try {
          const body = await loadScriptBody(s);
          if (body && typeof body === 'string' && body.trim() !== '') {
            s.hasBody = true;
            s.bodyPreview = body.slice(0, maxPreviewLength);
          }
        } catch (err) {
          console.error(
            'buildAdminStats: failed to load body preview for script',
            s.id,
            err
          );
          s.hasBody = false;
          s.bodyPreview = '';
        }
      })
    );
  }

  const execUsers = await loadExecUsers();

  const totalScripts = scripts.length;
  const totalGames = scripts.length;

  const uniqueUsersSet = new Set();
  const uniqueHwidsSet = new Set();
  const active24hUsers = new Set();

  let totalExecLifetime = 0;
  let executions24h = 0;

  execUsers.forEach((u) => {
    const totalExec = u.totalExecutes || 0;
    totalExecLifetime += totalExec;

    if (u.userId) uniqueUsersSet.add(String(u.userId));
    if (u.hwid) uniqueHwidsSet.add(String(u.hwid));

    const d = parseDateSafe(u.lastExecuteAt);
    if (d) {
      const diff = now - d;
      if (diff >= 0 && diff <= MS_24H) {
        executions24h += totalExec;
        if (u.userId) active24hUsers.add(String(u.userId));
      }
    }
  });

  const filteredExec = execUsers.filter(inSelectedPeriod);

  const totalUsers = uniqueUsersSet.size;
  const uniqueHwids = uniqueHwidsSet.size;
  const activeUsers24h = active24hUsers.size;

  const avgExecPerUser = totalUsers
    ? Number((totalExecLifetime / totalUsers).toFixed(1))
    : 0;
  const avgExecPerHwid = uniqueHwids
    ? Number((totalExecLifetime / uniqueHwids).toFixed(1))
    : 0;

  function timeAgoString(dateStr) {
    const d = parseDateSafe(dateStr);
    if (!d) return '-';
    const diffMs = now - d;
    if (diffMs < 0) return '-';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return `${sec}s lalu`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m lalu`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h}j lalu`;
    const day = Math.floor(h / 24);
    return `${day}h lalu`;
  }

  const recentExecutions = filteredExec
    .slice()
    .sort((a, b) => {
      const da = parseDateSafe(a.lastExecuteAt) || 0;
      const db = parseDateSafe(b.lastExecuteAt) || 0;
      return db - da;
    })
    .slice(0, 100)
    .map((u) => {
      const d = parseDateSafe(u.lastExecuteAt);
      const scriptMeta = scripts.find((s) => s.id === u.scriptId) || {};
      return {
        timeAgo: timeAgoString(u.lastExecuteAt),
        executedAtIso: u.lastExecuteAt || null,
        executedAtHuman: d ? d.toLocaleString('id-ID') : u.lastExecuteAt || '',
        scriptId: u.scriptId,
        scriptName: scriptMeta.name || u.scriptId || '-',
        userId: u.userId,
        username: u.username || null,
        displayName: u.displayName || null,
        hwid: u.hwid || null,
        executorUse: u.executorUse || null,
        key: u.keyToken || null,
        executeCount: u.clientExecuteCount || u.totalExecutes || 1,
        mapName: u.mapName || null,
        placeId: u.placeId || null,
        serverId: u.serverId || null,
        gameId: u.gameId || null,
        allMapList: Array.isArray(u.allMapList) ? u.allMapList : []
      };
    });

  const scriptMap = new Map();
  execUsers.forEach((u) => {
    const id = u.scriptId || 'unknown';
    const cur = scriptMap.get(id) || {
      id,
      executions: 0,
      name: id,
      gameName: ''
    };
    cur.executions += u.totalExecutes || 0;
    scriptMap.set(id, cur);
  });
  scripts.forEach((s) => {
    const cur = scriptMap.get(s.id);
    if (cur) {
      cur.name = s.name || s.id;
      cur.gameName = s.gameName || '';
    }
  });
  const topScripts = Array.from(scriptMap.values())
    .sort((a, b) => b.executions - a.executions)
    .slice(0, 10);

  const userMap = new Map();
  execUsers.forEach((u) => {
    if (!u.userId) return;
    const id = String(u.userId);
    const cur = userMap.get(id) || {
      userId: id,
      username: u.username || '',
      displayName: u.displayName || '',
      executions: 0
    };
    cur.executions += u.totalExecutes || 0;
    if (u.username) cur.username = u.username;
    if (u.displayName) cur.displayName = u.displayName;
    userMap.set(id, cur);
  });
  const topUsers = Array.from(userMap.values())
    .sort((a, b) => b.executions - a.executions)
    .slice(0, 10);

  const hwidMap = new Map();
  execUsers.forEach((u) => {
    if (!u.hwid) return;
    const id = String(u.hwid);
    const cur = hwidMap.get(id) || {
      hwid: id,
      lastUsername: u.username || '',
      executions: 0
    };
    cur.executions += u.totalExecutes || 0;
    if (u.username) cur.lastUsername = u.username;
    hwidMap.set(id, cur);
  });
  const topHwids = Array.from(hwidMap.values())
    .sort((a, b) => b.executions - a.executions)
    .slice(0, 10);

  const loaderUsers = execUsers
    .slice()
    .sort((a, b) => {
      const da = parseDateSafe(a.lastExecuteAt) || 0;
      const db = parseDateSafe(b.lastExecuteAt) || 0;
      return db - da;
    })
    .map((u) => {
      const scriptMeta = scripts.find((s) => s.id === u.scriptId) || {};
      return {
        key: u.key || `${u.scriptId}:${u.userId}:${u.hwid}`,
        scriptId: u.scriptId,
        scriptName: scriptMeta.name || u.scriptId || '-',
        userId: u.userId,
        username: u.username || '',
        displayName: u.displayName || '',
        hwid: u.hwid || '',
        executorUse: u.executorUse || '',
        totalExecutes: u.totalExecutes || 0,
        lastExecuteAt: u.lastExecuteAt || '',
        lastIp: u.lastIp || '',
        keyToken: u.keyToken || null,
        keyCreatedAt: u.keyCreatedAt || null,
        keyExpiresAt: u.keyExpiresAt || null,
        mapName: u.mapName || null,
        placeId: u.placeId || null,
        serverId: u.serverId || null,
        gameId: u.gameId || null,
        allMapList: Array.isArray(u.allMapList) ? u.allMapList : []
      };
    });

  const stats = {
    period: period || '24h',
    totalGames,
    totalScripts,
    totalExecutions: totalExecLifetime,
    executions24h,
    totalUsers,
    activeUsers24h,
    uniqueHwids,
    avgExecPerUser,
    avgExecPerHwid,
    recentExecutions,
    topScripts,
    topUsers,
    topHwids,
    loaderUsers
  };

  return { stats, scripts };
}

// uses/users counter untuk loader
async function incrementCountersKV(script, req) {
  if (!hasKV) return;

  const baseKey = `exhub:script:${script.id}`;
  const usesKey = `${baseKey}:uses`;
  const ipSetKey = `${baseKey}:ips`;
  const usersKey = `${baseKey}:users`;

  kvIncr(usesKey).catch((err) => console.error('KV INCR error:', err));

  const ip = getClientIp(req);
  if (!ip || ip === 'unknown') return;

  try {
    await kvSAdd(ipSetKey, ip);
    const count = await kvSCard(ipSetKey);
    if (count != null) {
      await kvSet(usersKey, String(count));
    }
  } catch (err) {
    console.error('KV user counter error:', err);
  }
}

// ======================================================
// Web-key admin data (untuk /admin/keys & /api/isValidate)
// ======================================================

async function buildWebKeysAdminData() {
  const siteConfig = await loadSiteConfig();
  const defaultKeyHours =
    typeof siteConfig.defaultKeyHours === 'number'
      ? siteConfig.defaultKeyHours
      : DEFAULT_KEY_HOURS;
  const maxKeysPerIp =
    typeof siteConfig.maxKeysPerIp === 'number'
      ? siteConfig.maxKeysPerIp
      : MAX_KEYS_PER_IP;

  const webKeys = await loadWebKeys();
  const nowMs = Date.now();

  const ipMap = new Map();

  for (const k of webKeys) {
    if (!k || !k.token) continue;
    const ip = (k.ip || 'unknown').trim() || 'unknown';
    if (!ipMap.has(ip)) ipMap.set(ip, []);
    ipMap.get(ip).push(k);
  }

  function parseMs(value) {
    if (!value) return 0;
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }

  function computeExpiresMs(entry, createdMs) {
    let expiresMs = null;
    if (entry.expiresAt) {
      const t = Date.parse(entry.expiresAt);
      if (!Number.isNaN(t)) {
        expiresMs = t;
      }
    }
    if (!expiresMs && createdMs && defaultKeyHours > 0) {
      expiresMs = createdMs + defaultKeyHours * 60 * 60 * 1000;
    }
    return expiresMs;
  }

  const ipStats = [];
  const ipDetails = new Map();

  let totalKeys = 0;
  let activeKeys = 0;

  ipMap.forEach((entries, ip) => {
    let total = 0;
    let active = 0;
    let lastCreatedMs = 0;
    let lastExpiresMs = 0;

    const detailList = [];

    for (const entry of entries) {
      total += 1;
      totalKeys += 1;

      const createdMs = parseMs(entry.createdAt || '');
      const expiresMs = computeExpiresMs(entry, createdMs);

      const expired = !!(expiresMs && expiresMs <= nowMs);
      if (!expired) {
        active += 1;
        activeKeys += 1;
      }

      if (createdMs > lastCreatedMs) lastCreatedMs = createdMs;
      if (expiresMs && expiresMs > lastExpiresMs) lastExpiresMs = expiresMs;

      const diff = expiresMs ? expiresMs - nowMs : null;
      const timeLeftLabel =
        expiresMs && !expired ? formatTimeLeft(diff) : 'Expired';

      detailList.push({
        token: entry.token,
        ip,
        userId: entry.userId || null,
        createdAt: entry.createdAt || '',
        expiresAt: entry.expiresAt || '',
        expiresAtMs: expiresMs || null,
        createdAtLabel: createdMs ? formatDualTimeLabelMs(createdMs) : '-',
        expiresAtLabel: expiresMs ? formatDualTimeLabelMs(expiresMs) : '-',
        timeLeftLabel,
        status: expired ? 'Expired' : 'Active'
      });
    }

    ipDetails.set(ip, detailList);

    ipStats.push({
      ip,
      totalKeys: total,
      activeKeys: active,
      lastCreatedAt:
        lastCreatedMs > 0 ? formatDualTimeLabelMs(lastCreatedMs) : '-',
      lastExpiresAt:
        lastExpiresMs > 0 ? formatDualTimeLabelMs(lastExpiresMs) : '-'
    });
  });

  return {
    ipStats,
    ipDetails,
    totalIpCount: ipStats.length,
    totalKeysCount: totalKeys,
    activeKeysCount: activeKeys,
    defaultKeyHours,
    maxKeysPerIp
  };
}

// ======================================================
// Express setup
// ======================================================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'dev-secret'],
    maxAge: 24 * 60 * 60 * 1000
  })
);

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// ======================================================
// Public pages
// ======================================================

app.get('/', async (req, res) => {
  const scripts = await loadScriptsHydrated();
  const stats = computeStats(scripts);

  res.render('index', { stats, scripts });
});

app.get('/scripts', async (req, res) => {
  const scripts = await loadScriptsHydrated();
  const stats = computeStats(scripts);

  res.render('scripts', { scripts, stats });
});

// ======================================================
// Loader API (/api/script/:id)
// ======================================================

app.get('/api/script/:id', async (req, res) => {
  const scriptId = req.params.id;
  const scripts = await loadScripts();
  const script = scripts.find((s) => s.id === scriptId);

  const loaderSnippet = `loadstring(game:HttpGet("https://exc-webs.vercel.app/api/script/${scriptId}", true))()`;

  if (!script) {
    return res.status(404).render('api-404', {
      scriptId,
      loaderSnippet,
      reason: 'not_found'
    });
  }

  if (script.status === 'down') {
    return res.status(503).render('api-404', {
      scriptId: script.id,
      loaderSnippet,
      reason: 'down'
    });
  }

  const expectedKey = process.env.LOADER_KEY;
  const loaderKey = req.headers['x-loader-key'];

  const isRobloxUA = isRobloxUserAgent(req);
  const hasValidHeader = expectedKey && loaderKey === expectedKey;

  if (!hasValidHeader && !isRobloxUA) {
    return res.status(403).render('api-404', {
      scriptId: script.id,
      loaderSnippet,
      reason: 'forbidden'
    });
  }

  try {
    const content = await loadScriptBody(script);
    if (!content) {
      console.error('Script body not found for id:', script.id);
      return res.status(500).send('Server error (script body missing).');
    }

    script.uses = (script.uses || 0) + 1;
    await saveScripts(scripts);

    try {
      await incrementCountersKV(script, req);
    } catch (e) {
      console.error('incrementCountersKV failed:', e);
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(content);
  } catch (err) {
    console.error('Failed to serve /api/script:', err);
    return res.status(500).send('Server error.');
  }
});

// ======================================================
// Exec tracking API (/api/exec)
// ======================================================

function upsertMapHistory(entry, opts) {
  if (!entry || !opts) return;

  const mapName = opts.mapName || null;
  const placeIdRaw = opts.placeId;
  const gameIdRaw = opts.gameId;
  const serverIdRaw = opts.serverId;

  const placeId =
    placeIdRaw !== undefined && placeIdRaw !== null && placeIdRaw !== ''
      ? String(placeIdRaw)
      : null;
  const gameId =
    gameIdRaw !== undefined && gameIdRaw !== null && gameIdRaw !== ''
      ? String(gameIdRaw)
      : null;
  const serverId =
    serverIdRaw !== undefined && serverIdRaw !== null && serverIdRaw !== ''
      ? String(serverIdRaw)
      : null;

  if (!mapName && !placeId && !gameId && !serverId) return;

  const existing = Array.isArray(entry.allMapList) ? entry.allMapList : [];
  const rawList = existing.slice();

  rawList.push({
    mapName,
    placeId,
    gameId,
    serverId
  });

  const mapByKey = new Map();

  rawList.forEach((m) => {
    if (!m) return;

    const mName = m.mapName || null;
    const pId =
      m.placeId !== undefined && m.placeId !== null && m.placeId !== ''
        ? String(m.placeId)
        : null;
    const gId =
      m.gameId !== undefined && m.gameId !== null && m.gameId !== ''
        ? String(m.gameId)
        : null;

    if (!mName && !pId && !gId) return;

    const key = `${gId || ''}|${pId || ''}|${mName || ''}`;

    let target = mapByKey.get(key);
    if (!target) {
      target = {
        mapName: mName,
        placeId: pId,
        gameId: gId,
        serverIds: [],
        serverId: null
      };
      mapByKey.set(key, target);
    }

    const tmpServerIds = [];

    if (Array.isArray(m.serverIds)) {
      m.serverIds.forEach((sid) => {
        if (sid !== undefined && sid !== null && sid !== '') {
          tmpServerIds.push(String(sid));
        }
      });
    }

    if (m.serverId !== undefined && m.serverId !== null && m.serverId !== '') {
      tmpServerIds.push(String(m.serverId));
    }

    tmpServerIds.forEach((sid) => {
      if (!target.serverIds.includes(sid)) {
        target.serverIds.push(sid);
      }
    });

    if (target.serverIds.length) {
      target.serverId = target.serverIds[target.serverIds.length - 1];
    }
  });

  entry.allMapList = Array.from(mapByKey.values());
}

async function upsertExecUserKV(meta) {
  if (!hasKV) return null;

  const {
    scriptId,
    userId,
    username,
    displayName,
    hwid,
    executorUse,
    execCountNum,
    keyToken,
    createdAtStr,
    expiresAtStr,
    ip,
    mapName,
    placeId,
    serverId,
    gameId
  } = meta;

  const compositeKey = `${String(scriptId)}:${String(userId)}:${String(
    hwid
  )}`;
  const nowIso = new Date().toISOString();

  let entry = null;
  try {
    const raw = await kvGet(KV_EXEC_ENTRY_PREFIX + compositeKey);
    if (raw && typeof raw === 'string' && raw !== '') {
      entry = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Failed to read exec-user from KV:', err);
  }

  if (!entry) {
    entry = {
      key: compositeKey,
      scriptId: String(scriptId),
      userId: String(userId),
      username: username || null,
      displayName: displayName || null,
      hwid: String(hwid),
      executorUse: executorUse || null,
      clientExecuteCount: execCountNum,
      keyToken: keyToken || null,
      keyCreatedAt: createdAtStr || null,
      keyExpiresAt: expiresAtStr || null,
      firstExecuteAt: nowIso,
      lastExecuteAt: nowIso,
      lastIp: ip,
      totalExecutes: 1,
      mapName: mapName || null,
      placeId:
        placeId !== undefined && placeId !== null ? String(placeId) : null,
      serverId: serverId || null,
      gameId:
        gameId !== undefined && gameId !== null ? String(gameId) : null,
      allMapList: []
    };
  } else {
    entry.username = username || entry.username;
    entry.displayName = displayName || entry.displayName;
    entry.lastExecuteAt = nowIso;
    entry.lastIp = ip;
    entry.totalExecutes = (entry.totalExecutes || 0) + 1;

    if (executorUse) entry.executorUse = executorUse;
    if (execCountNum != null) entry.clientExecuteCount = execCountNum;
    if (keyToken) entry.keyToken = keyToken;
    if (createdAtStr) entry.keyCreatedAt = createdAtStr;
    if (expiresAtStr) entry.keyExpiresAt = expiresAtStr;

    if (mapName) entry.mapName = mapName;
    if (placeId !== undefined && placeId !== null) {
      entry.placeId = String(placeId);
    }
    if (serverId) entry.serverId = serverId;
    if (gameId !== undefined && gameId !== null) {
      entry.gameId = String(gameId);
    }

    if (!Array.isArray(entry.allMapList)) entry.allMapList = [];
  }

  upsertMapHistory(entry, { mapName, placeId, serverId, gameId });

  try {
    await kvSet(KV_EXEC_ENTRY_PREFIX + compositeKey, JSON.stringify(entry));
    await kvSAdd(KV_EXEC_INDEX_KEY, compositeKey);
  } catch (err) {
    console.error('Failed to upsert exec-user to KV:', err);
  }

  return entry;
}

app.post('/api/exec', async (req, res) => {
  try {
    const {
      scriptId,
      userId,
      username,
      displayName,
      hwid,
      executorUse,
      executeCount,
      clientExecuteCount,
      key,
      Key,
      createdAt,
      expiresAt,
      mapName,
      placeId,
      serverId,
      gameId
    } = req.body || {};

    if (!scriptId || !userId || !hwid) {
      return res.status(400).json({
        error: 'missing_fields',
        required: ['scriptId', 'userId', 'hwid']
      });
    }

    let execCountNum = null;
    const rawExecCount =
      executeCount !== undefined && executeCount !== null
        ? executeCount
        : clientExecuteCount;

    if (rawExecCount !== undefined && rawExecCount !== null) {
      const n = parseInt(rawExecCount, 10);
      if (!Number.isNaN(n)) execCountNum = n;
    }

    const keyToken = key || Key || null;

    const createdAtStr =
      createdAt !== undefined && createdAt !== null ? String(createdAt) : null;
    const expiresAtStr =
      expiresAt !== undefined && expiresAt !== null
        ? String(expiresAt)
        : null;

    const ip = getClientIp(req);

    if (hasKV) {
      await upsertExecUserKV({
        scriptId,
        userId,
        username,
        displayName,
        hwid,
        executorUse,
        execCountNum,
        keyToken,
        createdAtStr,
        expiresAtStr,
        ip,
        mapName,
        placeId,
        serverId,
        gameId
      });
    } else {
      let execUsers = await loadExecUsers();
      const compositeKey = `${String(scriptId)}:${String(userId)}:${String(
        hwid
      )}`;
      const now = new Date().toISOString();

      let entry = execUsers.find((u) => u.key === compositeKey);

      if (!entry) {
        entry = {
          key: compositeKey,
          scriptId: String(scriptId),
          userId: String(userId),
          username: username || null,
          displayName: displayName || null,
          hwid: String(hwid),
          executorUse: executorUse || null,
          clientExecuteCount: execCountNum,
          keyToken: keyToken || null,
          keyCreatedAt: createdAtStr || null,
          keyExpiresAt: expiresAtStr || null,
          firstExecuteAt: now,
          lastExecuteAt: now,
          lastIp: ip,
          totalExecutes: 1,
          mapName: mapName || null,
          placeId:
            placeId !== undefined && placeId !== null ? String(placeId) : null,
          serverId: serverId || null,
          gameId:
            gameId !== undefined && gameId !== null ? String(gameId) : null,
          allMapList: []
        };

        upsertMapHistory(entry, { mapName, placeId, serverId, gameId });
        execUsers.push(entry);
      } else {
        entry.username = username || entry.username;
        entry.displayName = displayName || entry.displayName;
        entry.lastExecuteAt = now;
        entry.lastIp = ip;
        entry.totalExecutes = (entry.totalExecutes || 0) + 1;

        if (executorUse && executorUse !== '') entry.executorUse = executorUse;
        if (execCountNum != null) entry.clientExecuteCount = execCountNum;
        if (keyToken) entry.keyToken = keyToken;
        if (createdAtStr) entry.keyCreatedAt = createdAtStr;
        if (expiresAtStr) entry.keyExpiresAt = expiresAtStr;

        if (mapName) entry.mapName = mapName;
        if (placeId !== undefined && placeId !== null) {
          entry.placeId = String(placeId);
        }
        if (serverId) entry.serverId = serverId;
        if (gameId !== undefined && gameId !== null) {
          entry.gameId = String(gameId);
        }

        if (!Array.isArray(entry.allMapList)) entry.allMapList = [];
        upsertMapHistory(entry, { mapName, placeId, serverId, gameId });
      }

      await saveExecUsers(execUsers);
    }

    return res.json({
      ok: true,
      received: {
        scriptId,
        userId,
        username,
        displayName,
        hwid,
        executorUse,
        executeCount: execCountNum,
        key: keyToken,
        createdAt: createdAtStr,
        expiresAt: expiresAtStr,
        mapName,
        placeId,
        serverId,
        gameId
      }
    });
  } catch (err) {
    console.error('Failed to handle /api/exec:', err);
    return res.status(500).json({ error: 'exec_error' });
  }
});

app.get('/api/exec', async (req, res) => {
  try {
    const execUsers = await loadExecUsers();
    return res.json({ data: execUsers });
  } catch (err) {
    console.error('Failed to load exec users (GET /api/exec):', err);
    return res.status(500).json({ error: 'exec_users_error' });
  }
});

// ======================================================
// API isValidate (Luarmor-like, masih support web-keys lama)
// ======================================================

app.get('/api/isValidate/:key', async (req, res) => {
  try {
    const rawKey = (req.params.key || '').trim();
    if (!rawKey) {
      return res.status(400).json({
        valid: false,
        deleted: false,
        info: null
      });
    }

    const normKey = rawKey.toUpperCase();

    const execUsers = await loadExecUsers();
    const redeemedList = await loadRedeemedKeys();
    const webKeys = await loadWebKeys();
    const deletedList = await loadDeletedKeys();
    const siteConfig = await loadSiteConfig();

    const nowMs = Date.now();
    const defaultKeyHours =
      typeof siteConfig.defaultKeyHours === 'number'
        ? siteConfig.defaultKeyHours
        : DEFAULT_KEY_HOURS;

    let sourceExec = null;
    for (const u of execUsers) {
      if (!u || !u.keyToken) continue;
      if (String(u.keyToken).toUpperCase() === normKey) {
        sourceExec = u;
        break;
      }
    }

    let webEntry = null;
    for (const k of webKeys) {
      if (!k || !k.token) continue;
      if (String(k.token).toUpperCase() === normKey) {
        webEntry = k;
        break;
      }
    }

    let redeemed = null;
    if (!webEntry && !sourceExec) {
      for (const k of redeemedList) {
        if (!k || !k.key) continue;
        if (String(k.key).toUpperCase() === normKey) {
          redeemed = k;
          break;
        }
      }
    }

    let deletedEntry = null;
    for (const d of deletedList) {
      if (!d || !d.token) continue;
      if (String(d.token).toUpperCase() === normKey) {
        deletedEntry = d;
        break;
      }
    }

    const toMs = (value, fallbackMs) => {
      if (value == null) return fallbackMs;
      if (typeof value === 'number') return value;
      const str = String(value);
      if (/^\d+$/.test(str)) {
        const n = parseInt(str, 10);
        if (!Number.isNaN(n)) return n;
      }
      const d = new Date(str);
      const t = d.getTime();
      if (!Number.isNaN(t)) return t;
      return fallbackMs;
    };

    let valid = false;
    let deleted = false;
    let info = null;

    if (webEntry) {
      const createdMs = toMs(webEntry.createdAt, nowMs);

      let expiresMs = null;
      if (webEntry.expiresAfter != null) {
        expiresMs = toMs(webEntry.expiresAfter, null);
      }
      if (expiresMs == null) {
        expiresMs = toMs(webEntry.expiresAt, null);
      }
      if (expiresMs == null && createdMs && defaultKeyHours > 0) {
        expiresMs = createdMs + defaultKeyHours * 60 * 60 * 1000;
      }

      const expired = expiresMs != null && expiresMs <= nowMs;
      valid = !expired;

      let userIdNum = null;
      if (sourceExec && sourceExec.userId != null) {
        const n = Number(sourceExec.userId);
        userIdNum = Number.isNaN(n) ? null : n;
      } else if (webEntry.userId != null) {
        const n = Number(webEntry.userId);
        userIdNum = Number.isNaN(n) ? null : n;
      }

      info = {
        token: normKey,
        createdAt: createdMs,
        byIp:
          (sourceExec && sourceExec.lastIp) ||
          webEntry.ip ||
          '0.0.0.0',
        linkId: webEntry.linkId || null,
        userId: userIdNum,
        expiresAfter: expiresMs
      };
    } else if (sourceExec) {
      valid = true;

      const createdMs = toMs(sourceExec.keyCreatedAt, nowMs);
      const expiresMs =
        sourceExec.keyExpiresAt != null
          ? toMs(sourceExec.keyExpiresAt, null)
          : null;

      info = {
        token: normKey,
        createdAt: createdMs,
        byIp: sourceExec.lastIp || '0.0.0.0',
        linkId: null,
        userId: sourceExec.userId ? Number(sourceExec.userId) : null,
        expiresAfter: expiresMs
      };
    } else if (redeemed) {
      valid = true;

      const createdMs = toMs(redeemed.redeemedAt, nowMs);

      info = {
        token: normKey,
        createdAt: createdMs,
        byIp: redeemed.ip || '0.0.0.0',
        linkId: null,
        userId: null,
        expiresAfter: null
      };
    } else {
      valid = false;
      info = null;
    }

    if (deletedEntry) {
      deleted = true;
      valid = false;

      const deletedAtMs = toMs(deletedEntry.deletedAt, nowMs);

      if (!info) {
        info = {
          token: normKey,
          createdAt: null,
          byIp: deletedEntry.ip || '0.0.0.0',
          linkId: null,
          userId: null,
          expiresAfter: null
        };
      }
      info.deletedAt = deletedAtMs;
    }

    return res.json({ valid, deleted, info });
  } catch (err) {
    console.error('Failed to handle /api/isValidate:', err);
    return res.status(500).json({
      valid: false,
      deleted: false,
      info: null
    });
  }
});

// ======================================================
// API live stats
// ======================================================

app.get('/api/stats', async (req, res) => {
  try {
    const scripts = await loadScriptsHydrated();
    const stats = computeStats(scripts);

    res.json({
      stats,
      scripts: scripts.map((s) => ({
        id: s.id,
        uses: s.uses || 0,
        users: s.users || 0
      }))
    });
  } catch (err) {
    console.error('Failed to build /api/stats:', err);
    res.status(500).json({ error: 'stats_error' });
  }
});

// ======================================================
// Admin auth & dashboard
// ======================================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;

  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }

  return res.status(401).render('admin-login', {
    error: 'Username / password salah.'
  });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || '24h';
    const { stats, scripts } = await buildAdminStats(period, {
      withBodyPreview: true
    });
    const rawFiles = await loadRawFiles();

    res.render('admin-dashboard', {
      scripts,
      stats,
      keyCheck: null,
      userSearch: null,
      rawFiles
    });
  } catch (err) {
    console.error('Error rendering /admin dashboard:', err);
    return res.status(500).send('Admin dashboard error.');
  }
});

// ======================================================
// Admin: Key Checker & Roblox user search
// ======================================================

app.get('/admin/key-check', requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const rawQ = (req.query.q || '').trim();

    const { stats, scripts } = await buildAdminStats(period, {
      withBodyPreview: true
    });
    const rawFiles = await loadRawFiles();

    let keyCheck = null;

    if (rawQ) {
      const qLower = rawQ.toLowerCase();
      const loaderUsers = stats.loaderUsers || [];

      const matches = loaderUsers.filter((u) => {
        if (!u) return false;
        if (u.keyToken && String(u.keyToken).toLowerCase().includes(qLower)) {
          return true;
        }
        if (u.username && u.username.toLowerCase().includes(qLower)) {
          return true;
        }
        if (u.displayName && u.displayName.toLowerCase().includes(qLower)) {
          return true;
        }
        if (u.userId && String(u.userId).includes(rawQ)) {
          return true;
        }
        return false;
      });

      keyCheck = {
        query: rawQ,
        period,
        total: matches.length,
        matches: matches.slice(0, 200)
      };
    } else {
      keyCheck = {
        query: '',
        period,
        total: 0,
        matches: []
      };
    }

    res.render('admin-dashboard', {
      scripts,
      stats,
      keyCheck,
      userSearch: null,
      rawFiles
    });
  } catch (err) {
    console.error('Error rendering /admin/key-check:', err);
    return res.status(500).send('Key check error.');
  }
});

app.get('/admin/search/user', requireAdmin, async (req, res) => {
  const q = (req.query.q || '').trim();
  const period = req.query.period || '24h';

  try {
    const { stats, scripts } = await buildAdminStats(period, {
      withBodyPreview: true
    });
    const rawFiles = await loadRawFiles();

    const userSearch = {
      query: q,
      result: null,
      error: null
    };

    if (!q) {
      userSearch.error = 'Masukkan username atau userId Roblox.';
      return res.render('admin-dashboard', {
        scripts,
        stats,
        keyCheck: null,
        userSearch,
        rawFiles
      });
    }

    let robloxUser = null;

    if (/^\d+$/.test(q)) {
      try {
        const resp = await fetch(`https://users.roblox.com/v1/users/${q}`);
        if (!resp.ok) {
          throw new Error(`Roblox users API error: ${resp.status}`);
        }
        const data = await resp.json();
        robloxUser = {
          id: data.id,
          username: data.name,
          displayName: data.displayName,
          created: data.created,
          description: data.description || ''
        };
      } catch (err) {
        console.error('Roblox users/{id} error:', err);
        userSearch.error = 'UserId tidak ditemukan di Roblox.';
      }
    } else {
      try {
        const resp = await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            usernames: [q],
            excludeBannedUsers: false
          })
        });

        if (!resp.ok) {
          throw new Error(`Roblox usernames API error: ${resp.status}`);
        }

        const data = await resp.json();
        if (data && Array.isArray(data.data) && data.data.length > 0) {
          const u = data.data[0];
          robloxUser = {
            id: u.id,
            username: u.name,
            displayName: u.displayName,
            created: null,
            description: ''
          };

          try {
            const detailResp = await fetch(
              `https://users.roblox.com/v1/users/${u.id}`
            );
            if (detailResp.ok) {
              const detail = await detailResp.json();
              robloxUser.created = detail.created;
              robloxUser.description = detail.description || '';
            }
          } catch (detailErr) {
            console.error('Roblox user detail error:', detailErr);
          }
        } else {
          userSearch.error = 'Username tidak ditemukan di Roblox.';
        }
      } catch (err) {
        console.error('Roblox usernames/users error:', err);
        userSearch.error = 'Gagal menghubungi API Roblox (username).';
      }
    }

    if (robloxUser && robloxUser.id != null) {
      let avatarUrl = null;
      try {
        const thumbResp = await fetch(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUser.id}&size=150x150&format=Png&isCircular=false`
        );
        if (thumbResp.ok) {
          const thumbData = await thumbResp.json();
          if (
            thumbData &&
            Array.isArray(thumbData.data) &&
            thumbData.data[0] &&
            thumbData.data[0].imageUrl
          ) {
            avatarUrl = thumbData.data[0].imageUrl;
          }
        }
      } catch (err) {
        console.error('Roblox avatar thumbnail error:', err);
      }

      userSearch.result = {
        id: robloxUser.id,
        username: robloxUser.username,
        displayName: robloxUser.displayName,
        created: robloxUser.created,
        description: robloxUser.description,
        avatarUrl,
        profileUrl: `https://www.roblox.com/users/${robloxUser.id}/profile`
      };
    }

    if (!userSearch.result && !userSearch.error) {
      userSearch.error = 'User tidak ditemukan di Roblox.';
    }

    return res.render('admin-dashboard', {
      scripts,
      stats,
      keyCheck: null,
      userSearch,
      rawFiles
    });
  } catch (err) {
    console.error('Error in /admin/search/user:', err);
    const fallback = await buildAdminStats('24h', {
      withBodyPreview: true
    }).catch(() => null);
    const stats = fallback ? fallback.stats : { period: '24h' };
    const scripts = fallback ? fallback.scripts : [];
    const userSearch = {
      query: q,
      result: null,
      error: 'Terjadi kesalahan saat mencari user Roblox.'
    };
    let rawFiles = [];
    try {
      rawFiles = await loadRawFiles();
    } catch (e) {
      rawFiles = [];
    }
    return res.render('admin-dashboard', {
      scripts,
      stats,
      keyCheck: null,
      userSearch,
      rawFiles
    });
  }
});

// ======================================================
// Admin exec-users delete
// ======================================================

app.post('/admin/exec-users/delete', requireAdmin, async (req, res) => {
  try {
    const entryKey = (req.body.entryKey || '').trim();
    const back = req.get('Referrer') || '/admin';

    if (!entryKey) {
      return res.redirect(back);
    }

    if (hasKV) {
      try {
        await kvSRem(KV_EXEC_INDEX_KEY, entryKey);
        await kvDel(KV_EXEC_ENTRY_PREFIX + entryKey);
      } catch (err) {
        console.error('Failed to delete exec-user entry from KV:', err);
      }
    } else {
      let list = await loadExecUsers();
      const before = list.length;
      list = list.filter((u) => u.key !== entryKey);

      if (list.length !== before) {
        await saveExecUsers(list);
      }
    }

    return res.redirect(back);
  } catch (err) {
    console.error('Failed to delete exec user entry:', err);
    const back = req.get('Referrer') || '/admin';
    return res.redirect(back);
  }
});

// ======================================================
// Admin: Script body viewer (FULL RAW, hanya ADMIN)
// ======================================================

app.get('/admin/scripts/:id/body', requireAdmin, async (req, res) => {
  try {
    const scripts = await loadScripts();
    const script = scripts.find((s) => s.id === req.params.id);
    if (!script) {
      return res.status(404).send('Script not found.');
    }
    const body = await loadScriptBody(script);
    if (body == null) {
      return res.status(404).send('Script body not found.');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(body);
  } catch (err) {
    console.error('Failed to serve admin script body:', err);
    return res.status(500).send('Server error when reading script body.');
  }
});

// Debug JSON (meta) — dipakai tombol "Debug JSON" di admin-dashboard.ejs
app.get('/admin/scripts/:id/debug-json', requireAdmin, async (req, res) => {
  try {
    const scripts = await loadScripts();
    const script = scripts.find((s) => s.id === req.params.id);
    if (!script) {
      return res.status(404).json({ error: 'Script not found.' });
    }

    let hasBody = false;
    try {
      const body = await loadScriptBody(script);
      hasBody = !!(body && typeof body === 'string' && body.trim() !== '');
    } catch (err) {
      console.error(
        'Failed to check body presence for debug-json:',
        script.id,
        err
      );
    }

    return res.json({
      ...script,
      hasBody
    });
  } catch (err) {
    console.error('Failed to serve admin script debug-json:', err);
    return res.status(500).json({
      error: 'Server error when reading script meta.'
    });
  }
});

// ======================================================
// Admin: scripts CRUD (Save / Delete / Clear Body)
// ======================================================

app.post(
  '/admin/scripts/:id',
  requireAdmin,
  upload.single('scriptUpload'),
  async (req, res) => {
    const scripts = await loadScripts();
    const idx = scripts.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.redirect('/admin#scripts-section');

    const s = scripts[idx];
    const action = (req.body._action || 'save').trim();

    // DELETE SCRIPT: hapus meta + clear body
    if (action === 'delete') {
      const scriptId = s.id;
      scripts.splice(idx, 1);
      await saveScripts(scripts);

      try {
        await removeScriptBody(scriptId);
      } catch (err) {
        console.error('Failed to remove script body on delete:', err);
      }

      return res.redirect('/admin#scripts-section');
    }

    // Update metadata dasar (dipakai untuk save & clear-body)
    s.name = req.body.name || s.name;
    s.gameName = req.body.gameName || s.gameName;
    s.version = req.body.version || s.version;
    s.status = req.body.status || s.status;
    s.isFree = req.body.isFree === 'on';
    s.uses = parseInt(req.body.uses || s.uses || 0, 10);
    s.users = parseInt(req.body.users || s.users || 0, 10);
    s.thumbnail = req.body.thumbnail || s.thumbnail;
    s.scriptFile = req.body.scriptFile || s.scriptFile;

    // CLEAR BODY: kosongkan isi script tanpa menghapus meta
    if (action === 'clear-body') {
      try {
        await removeScriptBody(s.id);
      } catch (err) {
        console.error('Failed to clear script body:', err);
      }

      await saveScripts(scripts);

      try {
        await syncScriptCountersToKV(s);
      } catch (e) {
        console.error('syncScriptCountersToKV failed after clear-body:', e);
      }

      return res.redirect('/admin#scripts-section');
    }

    // Default: SAVE (update meta + optional body baru)
    const finalBody = extractBodyFromReq(req, 'scriptBody');

    if (finalBody != null) {
      try {
        await saveScriptBody(s.id, finalBody);
      } catch (err) {
        console.error('Failed to save script body (update):', err);
      }
    }

    await saveScripts(scripts);

    try {
      await syncScriptCountersToKV(s);
    } catch (e) {
      console.error('syncScriptCountersToKV failed:', e);
    }

    return res.redirect('/admin#scripts-section');
  }
);

app.post(
  '/admin/scripts',
  requireAdmin,
  upload.single('scriptUpload'),
  async (req, res) => {
    const scripts = await loadScripts();
    const id = (req.body.id || '').trim();

    if (!id || scripts.some((s) => s.id === id)) {
      return res.redirect('/admin#scripts-section');
    }

    const newScript = {
      id,
      name: req.body.name || id,
      gameName: req.body.gameName || '',
      version: req.body.version || 'v1.0.0',
      isFree: req.body.isFree === 'on',
      status: req.body.status || 'working',
      uses: parseInt(req.body.uses || 0, 10),
      users: parseInt(req.body.users || 0, 10),
      thumbnail: req.body.thumbnail || '',
      scriptFile: req.body.scriptFile || ''
    };

    scripts.push(newScript);
    await saveScripts(scripts);

    const finalBody = extractBodyFromReq(req, 'scriptBody');

    if (finalBody != null) {
      try {
        await saveScriptBody(newScript.id, finalBody);
      } catch (err) {
        console.error('Failed to save script body (new):', err);
      }
    }

    try {
      await syncScriptCountersToKV(newScript);
    } catch (e) {
      console.error('syncScriptCountersToKV (new) failed:', e);
    }

    res.redirect('/admin#scripts-section');
  }
);

// ======================================================
// Admin: Private Raw Files CRUD + viewer
// ======================================================

app.post(
  '/admin/raw-files/:id',
  requireAdmin,
  upload.single('rawUpload'),
  async (req, res) => {
    const id = (req.params.id || '').trim();
    if (!id) return res.redirect('/admin#raw-files');

    let rawFiles = await loadRawFiles();
    const idx = rawFiles.findIndex((f) => f.id === id);
    if (idx === -1) return res.redirect('/admin#raw-files');

    const action = (req.body._action || '').trim();

    if (action === 'delete') {
      rawFiles = rawFiles.filter((f) => f.id !== id);
      await saveRawFiles(rawFiles);
      try {
        await removeRawBody(id);
      } catch (err) {
        console.error('Failed to remove raw body on delete:', err);
      }
      return res.redirect('/admin#raw-files');
    }

    const file = rawFiles[idx];
    file.name = req.body.name || file.name || '';
    file.note = req.body.note || file.note || '';

    const now = new Date().toISOString();

    const finalBody = extractBodyFromReq(req, 'body');

    if (finalBody != null) {
      try {
        await saveRawBody(id, finalBody);
        file.preview = finalBody.slice(0, 800);
      } catch (err) {
        console.error('Failed to save raw body (update):', err);
      }
      file.updatedAt = now;
    } else {
      file.updatedAt = file.updatedAt || now;
    }

    await saveRawFiles(rawFiles);

    return res.redirect('/admin#raw-files');
  }
);

app.post(
  '/admin/raw-files',
  requireAdmin,
  upload.single('rawUpload'),
  async (req, res) => {
    const id = (req.body.id || '').trim();
    if (!id) return res.redirect('/admin#raw-files');

    let rawFiles = await loadRawFiles();
    if (rawFiles.some((f) => f.id === id)) {
      return res.redirect('/admin#raw-files');
    }

    const now = new Date().toISOString();
    const finalBody = extractBodyFromReq(req, 'body') || '';

    const newFile = {
      id,
      name: req.body.name || '',
      note: req.body.note || '',
      updatedAt: now,
      preview: finalBody ? finalBody.slice(0, 800) : ''
    };

    rawFiles.push(newFile);
    await saveRawFiles(rawFiles);

    if (finalBody) {
      try {
        await saveRawBody(id, finalBody);
      } catch (err) {
        console.error('Failed to save raw body (new):', err);
      }
    }

    return res.redirect('/admin#raw-files');
  }
);

// viewer untuk raw body (ADMIN only)
app.get('/admin/raw-files/:id/body', requireAdmin, async (req, res) => {
  try {
    const rawId = (req.params.id || '').trim();
    if (!rawId) return res.status(400).send('Missing rawId.');
    const rawFiles = await loadRawFiles();
    const meta = rawFiles.find((f) => f.id === rawId);
    if (!meta) return res.status(404).send('Raw file not registered.');
    const body = await loadRawBody(rawId);
    if (body == null) return res.status(404).send('Raw body not found.');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(body);
  } catch (err) {
    console.error('Failed to serve admin raw body:', err);
    return res.status(500).send('Server error when reading raw body.');
  }
});

// ======================================================
// Admin Web Key Manager (/admin/keys)
// ======================================================

app.get('/admin/keys', requireAdmin, async (req, res) => {
  try {
    const selectedIp = (req.query.ip || '').trim();
    const queryRaw = (req.query.q || '').trim();
    const query = queryRaw.toLowerCase();

    const {
      ipStats,
      ipDetails,
      totalIpCount,
      totalKeysCount,
      activeKeysCount,
      defaultKeyHours,
      maxKeysPerIp
    } = await buildWebKeysAdminData();

    let filteredIpStats = ipStats;

    if (query) {
      const matchIp = new Set();

      ipStats.forEach((row) => {
        if (row.ip.toLowerCase().includes(query)) {
          matchIp.add(row.ip);
        }
      });

      ipDetails.forEach((list, ip) => {
        if (matchIp.has(ip)) return;
        const hit = list.some((k) => {
          const token = (k.token || '').toLowerCase();
          const uidStr = k.userId != null ? String(k.userId) : '';
          return (
            token.includes(query) ||
            uidStr.includes(queryRaw)
          );
        });
        if (hit) matchIp.add(ip);
      });

      filteredIpStats = ipStats.filter((row) => matchIp.has(row.ip));
    }

    let selectedKeys = [];
    if (selectedIp && ipDetails.has(selectedIp)) {
      selectedKeys = ipDetails.get(selectedIp) || [];
    }

    return res.render('admin-dashboardkey', {
      title: 'Admin – Web Key Manager',
      query: queryRaw,
      ipStats: filteredIpStats,
      selectedIp,
      selectedKeys,
      totalIpCount,
      totalKeysCount,
      activeKeysCount,
      defaultKeyHours,
      maxKeysPerIp
    });
  } catch (err) {
    console.error('Error rendering /admin/keys:', err);
    return res.status(500).send('Admin key dashboard error.');
  }
});

app.post('/admin/keys/update-default', requireAdmin, async (req, res) => {
  try {
    const raw = (req.body.defaultKeyHours || '').toString().trim();
    let hours = parseInt(raw, 10);

    const currentCfg = await loadSiteConfig();

    if (!Number.isFinite(hours)) {
      hours =
        typeof currentCfg.defaultKeyHours === 'number'
          ? currentCfg.defaultKeyHours
          : DEFAULT_KEY_HOURS;
    } else {
      if (hours < 1) hours = 1;
      if (hours > 168) hours = 168;
    }

    const updatedCfg = {
      ...currentCfg,
      defaultKeyHours: hours
    };

    await saveSiteConfig(updatedCfg);
  } catch (err) {
    console.error(
      'Failed to update defaultKeyHours via /admin/keys/update-default:',
      err
    );
  }

  return res.redirect('/admin/keys');
});

app.post('/admin/keys/delete-ip', requireAdmin, async (req, res) => {
  try {
    const ip = (req.body.ip || '').trim();
    const back = '/admin/keys';

    if (!ip) {
      return res.redirect(back);
    }

    let webKeys = await loadWebKeys();
    let deletedKeys = await loadDeletedKeys();
    const before = webKeys.length;
    const nowIso = new Date().toISOString();

    const toDelete = webKeys.filter((k) => k && k.ip === ip);
    if (toDelete.length > 0) {
      for (const k of toDelete) {
        if (!k || !k.token) continue;
        const tok = String(k.token);
        const exists = deletedKeys.some(
          (d) => d && String(d.token) === tok
        );
        if (!exists) {
          deletedKeys.push({
            token: tok,
            deletedAt: nowIso,
            ip: k.ip || ip,
            reason: 'delete-ip'
          });
        }
      }
      await saveDeletedKeys(deletedKeys);
    }

    webKeys = webKeys.filter((k) => k && k.ip !== ip);

    if (webKeys.length !== before) {
      await saveWebKeys(webKeys);
    }

    return res.redirect(back);
  } catch (err) {
    console.error('Failed to delete keys by IP:', err);
    return res.redirect('/admin/keys');
  }
});

app.post('/admin/keys/delete-key', requireAdmin, async (req, res) => {
  try {
    const token = (req.body.token || '').trim();
    const ip = (req.body.ip || '').trim();
    const back = ip
      ? `/admin/keys?ip=${encodeURIComponent(ip)}`
      : '/admin/keys';

    if (!token) {
      return res.redirect(back);
    }

    let webKeys = await loadWebKeys();
    let deletedKeys = await loadDeletedKeys();
    const before = webKeys.length;
    const nowIso = new Date().toISOString();

    let removedEntry = null;
    const remaining = [];

    for (const k of webKeys) {
      if (!k) continue;
      if (!removedEntry && String(k.token) === String(token)) {
        removedEntry = k;
        continue;
      }
      remaining.push(k);
    }

    webKeys = remaining;

    if (removedEntry) {
      const tok = String(removedEntry.token);
      const exists = deletedKeys.some(
        (d) => d && String(d.token) === tok
      );
      if (!exists) {
        deletedKeys.push({
          token: tok,
          deletedAt: nowIso,
          ip: removedEntry.ip || ip || 'unknown',
          reason: 'delete-key'
        });
        await saveDeletedKeys(deletedKeys);
      }
    }

    if (webKeys.length !== before) {
      await saveWebKeys(webKeys);
    }

    return res.redirect(back);
  } catch (err) {
    console.error('Failed to delete key:', err);
    return res.redirect('/admin/keys');
  }
});

app.post('/admin/keys/update-key', requireAdmin, async (req, res) => {
  try {
    const token = (req.body.token || '').trim();
    const ip = (req.body.ip || '').trim();
    const newCreatedAt = (req.body.createdAt || '').trim();
    const newExpiresAtRaw = (req.body.expiresAt || '').trim();

    const backBase = ip
      ? `/admin/keys?ip=${encodeURIComponent(ip)}`
      : '/admin/keys';
    const back =
      token && ip
        ? backBase + `#token-${encodeURIComponent(token)}`
        : backBase;

    if (!token) {
      return res.redirect(backBase);
    }

    let webKeys = await loadWebKeys();
    let changed = false;
    const nowMs = Date.now();

    webKeys = webKeys.map((k) => {
      if (!k || String(k.token) !== String(token)) return k;
      const updated = { ...k };

      updated.createdAt = newCreatedAt;

      let finalExpiresAt = newExpiresAtRaw;

      if (newExpiresAtRaw) {
        const relMs = parseRelativeExpiresInput(newExpiresAtRaw, nowMs);
        if (relMs) {
          finalExpiresAt = new Date(relMs).toISOString();
        }
      } else {
        finalExpiresAt = '';
      }

      updated.expiresAt = finalExpiresAt;
      changed = true;
      return updated;
    });

    if (changed) {
      await saveWebKeys(webKeys);
    }

    return res.redirect(back);
  } catch (err) {
    console.error('Failed to update key timestamps:', err);
    return res.redirect('/admin/keys');
  }
});

app.post('/admin/keys/renew-key', requireAdmin, async (req, res) => {
  try {
    const token = (req.body.token || '').trim();
    const ip = (req.body.ip || '').trim();

    const backBase = ip
      ? `/admin/keys?ip=${encodeURIComponent(ip)}`
      : '/admin/keys';
    const back =
      token && ip
        ? backBase + `#token-${encodeURIComponent(token)}`
        : backBase;

    if (!token) {
      return res.redirect(backBase);
    }

    const siteConfig = await loadSiteConfig();
    const defaultKeyHours =
      typeof siteConfig.defaultKeyHours === 'number'
        ? siteConfig.defaultKeyHours
        : DEFAULT_KEY_HOURS;

    let webKeys = await loadWebKeys();
    const nowMs = Date.now();
    const extendMs = defaultKeyHours * 60 * 60 * 1000;

    let changed = false;

    webKeys = webKeys.map((k) => {
      if (!k || String(k.token) !== String(token)) return k;
      const updated = { ...k };
      const newExpiresMs = nowMs + extendMs;
      updated.expiresAt = new Date(newExpiresMs).toISOString();
      changed = true;
      return updated;
    });

    if (changed) {
      await saveWebKeys(webKeys);
    }

    return res.redirect(back);
  } catch (err) {
    console.error('Failed to renew key via admin:', err);
    return res.redirect('/admin/keys');
  }
});

// ======================================================
// Admin exec-users API JSON
// ======================================================

app.get('/admin/api/exec-users', requireAdmin, async (req, res) => {
  try {
    const execUsers = await loadExecUsers();
    res.json({ data: execUsers });
  } catch (err) {
    console.error('Failed to load exec users:', err);
    res.status(500).json({ error: 'exec_users_error' });
  }
});

app.get(
  '/admin/api/exec-users/:scriptId',
  requireAdmin,
  async (req, res) => {
    try {
      const execUsers = await loadExecUsers();
      const filtered = execUsers.filter(
        (u) => u.scriptId === String(req.params.scriptId)
      );
      res.json({ data: filtered });
    } catch (err) {
      console.error('Failed to load exec users by scriptId:', err);
      res.status(500).json({ error: 'exec_users_error' });
    }
  }
);

// ======================================================
// Public Bot API (Discord)
// ======================================================

async function buildBotStatsPayload() {
  const { stats } = await buildAdminStats('all');
  let totalKeys = 0;
  let activeKeys = 0;

  try {
    const webKeysData = await buildWebKeysAdminData();
    totalKeys = webKeysData.totalKeysCount || 0;
    activeKeys = webKeysData.activeKeysCount || 0;
  } catch (err) {
    console.error('buildWebKeysAdminData in /api/bot/stats failed:', err);
  }

  let lastExecutionAt = null;
  if (
    stats &&
    Array.isArray(stats.recentExecutions) &&
    stats.recentExecutions.length
  ) {
    lastExecutionAt = stats.recentExecutions[0].executedAtIso;
  }

  return {
    ok: true,
    totalExecutions: stats.totalExecutions || 0,
    usersCount: stats.totalUsers || 0,
    scriptsCount: stats.totalScripts || stats.totalGames || 0,
    totalKeys,
    activeKeys,
    lastExecutionAt,
    apiUptimeSeconds: getApiUptimeSeconds()
  };
}

app.get('/api/bot/stats', async (req, res) => {
  try {
    const payload = await buildBotStatsPayload();
    return res.json(payload);
  } catch (err) {
    console.error('Failed to handle /api/bot/stats:', err);
    return res.status(500).json({
      ok: false,
      error: 'bot_stats_error'
    });
  }
});

function deriveUserTier(totalExec) {
  if (!Number.isFinite(totalExec) || totalExec <= 0) return 'NEW';
  if (totalExec > 5000) return 'DIAMOND';
  if (totalExec > 2000) return 'PLATINUM';
  if (totalExec > 500) return 'GOLD';
  if (totalExec > 100) return 'SILVER';
  if (totalExec > 10) return 'BRONZE';
  return 'NEW';
}

async function buildBotUserInfoPayload(discordId, discordTag) {
  const id = String(discordId || '').trim();
  const tag = discordTag ? String(discordTag).trim() : null;

  if (!id) {
    return {
      success: false,
      message: 'Missing discordId',
      discordId: null,
      discordTag: tag,
      userTier: null,
      totalExecutions: 0,
      lastExecutionAt: null,
      keys: []
    };
  }

  const execUsers = await loadExecUsers();
  const webKeys = await loadWebKeys();

  const relatedExec = execUsers.filter(
    (u) => u && String(u.userId || '') === id
  );

  let totalExecutions = 0;
  let lastExecutionAt = null;

  const pickLatest = (a, b) => {
    const ta = a ? Date.parse(a) : NaN;
    const tb = b ? Date.parse(b) : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return null;
    if (Number.isNaN(ta)) return b;
    if (Number.isNaN(tb)) return a;
    return tb > ta ? b : a;
  };

  const keyObjects = [];

  relatedExec.forEach((u) => {
    const exec = u.totalExecutes || 0;
    totalExecutions += exec;
    lastExecutionAt = pickLatest(lastExecutionAt, u.lastExecuteAt);

    if (u.keyToken) {
      keyObjects.push({
        key: String(u.keyToken),
        token: String(u.keyToken),
        source: 'exec',
        scriptId: u.scriptId || null,
        lastExecuteAt: u.lastExecuteAt || null
      });
    }
  });

  webKeys.forEach((k) => {
    if (!k || !k.token) return;
    if (k.userId != null && String(k.userId) === id) {
      keyObjects.push({
        key: String(k.token),
        token: String(k.token),
        source: 'generate',
        createdAt: k.createdAt || null,
        expiresAt: k.expiresAt || null,
        ip: k.ip || null
      });
    }
  });

  const seen = new Set();
  const uniqueKeys = [];
  for (const k of keyObjects) {
    const tok = String(k.token || k.key || '');
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    uniqueKeys.push(k);
  }

  if (!relatedExec.length && !uniqueKeys.length) {
    return {
      success: false,
      message: 'No ExHub data linked for this ID.',
      discordId: id,
      discordTag: tag,
      userTier: null,
      totalExecutions: 0,
      lastExecutionAt: null,
      keys: []
    };
  }

  const tier = deriveUserTier(totalExecutions);

  return {
    success: true,
    discordId: id,
    discordTag: tag,
    userTier: tier,
    totalExecutions,
    lastExecutionAt,
    keys: uniqueKeys
  };
}

async function handleBotUserInfo(req, res) {
  try {
    const body = req.body || {};
    const discordId = body.discordId || req.query.discordId || null;
    const discordTag = body.discordTag || req.query.discordTag || null;

    const payload = await buildBotUserInfoPayload(discordId, discordTag);
    return res.json(payload);
  } catch (err) {
    console.error('Failed to handle /api/bot/user-info:', err);
    return res.status(500).json({
      success: false,
      message: 'internal_error'
    });
  }
}

app.post('/api/bot/user-info', handleBotUserInfo);
app.get('/api/bot/user-info', handleBotUserInfo);

app.get('/api/bot/ping', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: getApiUptimeSeconds()
  });
});

// ======================================================
// Mount serverv2 routes (Discord OAuth + key system baru)
// ======================================================

try {
  require('./serverv2')(app);
  console.log('[server] serverv2 routes mounted.');
} catch (err) {
  console.error('[server] Failed to mount serverv2 routes:', err);
}

// ======================================================
// Public raw link (/:id.raw)
// ======================================================

app.get('/:rawId.raw', async (req, res, next) => {
  try {
    const rawId = (req.params.rawId || '').trim();
    if (!rawId) return next();

    const rawFiles = await loadRawFiles();
    const fileMeta = rawFiles.find((f) => f.id === rawId);
    if (!fileMeta) {
      return next();
    }

    const body = await loadRawBody(rawId);
    if (!body) {
      return res.status(404).send('Raw file not found.');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(body);
  } catch (err) {
    console.error('Failed to serve raw link:', err);
    return res.status(500).send('Server error (raw).');
  }
});

// ======================================================
// Fallback 404
// ======================================================

app.use(async (req, res) => {
  const scripts = await loadScriptsHydrated();
  const stats = computeStats(scripts);
  res.status(404).render('index', { stats, scripts });
});

// ======================================================
// Start / export
// ======================================================

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ExHub site running on http://localhost:${PORT}`);
  });
}

module.exports = app;
