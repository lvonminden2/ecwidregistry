import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import fs from "fs";
import dotenv from "dotenv";
import session from "express-session";
import crypto from "crypto";
import { exec } from "child_process";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ECWID_CLIENT_ID = process.env.ECWID_CLIENT_ID || "";
const ECWID_CLIENT_SECRET = process.env.ECWID_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_session_secret";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// Legacy single-store env vars — used as fallbacks when no per-store record exists
const LEGACY_ECWID_STORE_ID = process.env.ECWID_STORE_ID || "";
const LEGACY_ECWID_ACCESS_TOKEN = process.env.ECWID_ACCESS_TOKEN || "";
// URL of the Ecwid storefront page where the widget is embedded.
// If set, all public-facing registry links point here instead of the standalone /registry page.
const PUBLIC_REGISTRY_URL = process.env.PUBLIC_REGISTRY_URL || "";
// URL of the page where the registry widget is embedded.
const REGISTRY_PAGE_URL = process.env.REGISTRY_PAGE_URL || '';
// Shipping rates for custom shipping handler
const SHIPPING_FLAT_RATE = Number(process.env.SHIPPING_FLAT_RATE || 5.99);
const SHIPPING_FREE_THRESHOLD = Number(process.env.SHIPPING_FREE_THRESHOLD || 0);
const ALLOW_NO_ECWID = process.env.ALLOW_NO_ECWID === "true";

const app = express();
app.set("trust proxy", 1); // Required for Railway/Heroku — trusts X-Forwarded-Proto for secure cookies
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Skip global body parsers for webhook routes — they need express.raw() for
// HMAC signature verification on the original bytes.
app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  express.urlencoded({ extended: true, limit: "12mb" })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith("/webhooks/")) return next();
  express.json({ limit: "12mb" })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/widget/registry.js" || req.path === "/widget/portal.js" || req.path === "/widget/cart-guard.js") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
  }
  next();
});
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});
app.use((req, res, next) => {
  if (req.path === "/ecwid/iframe") {
    const hasPayload = typeof req.query.payload === "string" && req.query.payload.length > 0;
    console.log(`[ecwid-iframe] method=${req.method} path=${req.originalUrl} has_payload=${hasPayload}`);
  }
  next();
});
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // "none" + secure:true is required for cookies to work inside Ecwid's iframe
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);
app.use("/public", express.static(path.join(__dirname, "public")));

const dbPath = path.join(__dirname, "data", "registry.db");
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}
const db = new Database(dbPath);

// Database init
const init = db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT,
      display_name TEXT NOT NULL,
      event_date TEXT,
      registry_type TEXT NOT NULL DEFAULT 'in_store',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS registry_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registry_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      product_sku TEXT,
      desired_qty INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (registry_id) REFERENCES registry(id)
    );
    CREATE TABLE IF NOT EXISTS registry_purchase (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registry_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      product_sku TEXT,
      qty INTEGER NOT NULL,
      buyer_name TEXT,
      buyer_email TEXT,
      notes TEXT,
      off_registry INTEGER NOT NULL DEFAULT 0,
      channel TEXT NOT NULL,
      order_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (registry_id) REFERENCES registry(id)
    );
  `);

  // registry_account table — one account per registry (registrant portal access)
  db.exec(`
    CREATE TABLE IF NOT EXISTS registry_account (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registry_id INTEGER NOT NULL UNIQUE,
      name TEXT,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      can_add_items INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (registry_id) REFERENCES registry(id)
    );
  `);

  const cols = db.prepare("PRAGMA table_info(registry)").all().map((c) => c.name);
  if (!cols.includes("store_id")) {
    db.exec("ALTER TABLE registry ADD COLUMN store_id TEXT");
  }
  if (!cols.includes("registry_type")) {
    db.exec("ALTER TABLE registry ADD COLUMN registry_type TEXT NOT NULL DEFAULT 'in_store'");
  }
  if (!cols.includes("photo")) {
    db.exec("ALTER TABLE registry ADD COLUMN photo TEXT");
  }
  if (!cols.includes("shipping_method")) {
    db.exec("ALTER TABLE registry ADD COLUMN shipping_method TEXT NOT NULL DEFAULT 'pickup'");
  }
  if (!cols.includes("shipping_address")) {
    db.exec("ALTER TABLE registry ADD COLUMN shipping_address TEXT");
  }
  if (!cols.includes("description")) {
    db.exec("ALTER TABLE registry ADD COLUMN description TEXT");
  }
  const itemCols = db.prepare("PRAGMA table_info(registry_item)").all().map((c) => c.name);
  if (!itemCols.includes("product_sku")) {
    db.exec("ALTER TABLE registry_item ADD COLUMN product_sku TEXT");
  }
  if (!itemCols.includes("product_thumbnail")) {
    db.exec("ALTER TABLE registry_item ADD COLUMN product_thumbnail TEXT");
  }
  const purchaseCols = db.prepare("PRAGMA table_info(registry_purchase)").all().map((c) => c.name);
  if (!purchaseCols.includes("product_name")) {
    db.exec("ALTER TABLE registry_purchase ADD COLUMN product_name TEXT");
  }
  if (!purchaseCols.includes("product_sku")) {
    db.exec("ALTER TABLE registry_purchase ADD COLUMN product_sku TEXT");
  }
  if (!purchaseCols.includes("notes")) {
    db.exec("ALTER TABLE registry_purchase ADD COLUMN notes TEXT");
  }
  if (!purchaseCols.includes("off_registry")) {
    db.exec("ALTER TABLE registry_purchase ADD COLUMN off_registry INTEGER NOT NULL DEFAULT 0");
  }
  // registry_account migrations
  const accountCols = db.prepare("PRAGMA table_info(registry_account)").all().map((c) => c.name);
  if (!accountCols.includes("ecwid_customer_id")) {
    db.exec("ALTER TABLE registry_account ADD COLUMN ecwid_customer_id TEXT");
  }

  // Settings key-value store
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Per-store credentials for public app (multi-store support)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      store_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      public_token TEXT,
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Per-store settings (key scoped by store_id)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_settings (
      store_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (store_id, key)
    );
  `);
});
init();

// ── Per-store credential helpers ────────────────────────────────────────────
function upsertStore(storeId, accessToken, publicToken) {
  db.prepare(`
    INSERT INTO stores (store_id, access_token, public_token, installed_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(store_id) DO UPDATE SET
      access_token = excluded.access_token,
      public_token = COALESCE(excluded.public_token, stores.public_token),
      updated_at = datetime('now')
  `).run(storeId, accessToken, publicToken || null);
}

function getStore(storeId) {
  return db.prepare("SELECT * FROM stores WHERE store_id = ?").get(storeId) || null;
}

function getAllStores() {
  return db.prepare("SELECT * FROM stores").all();
}

/** Resolve access token for a given store: DB record → legacy env var fallback */
function resolveStoreCredentials(storeId) {
  if (storeId) {
    const store = getStore(storeId);
    if (store) return { storeId, accessToken: store.access_token, publicToken: store.public_token };
  }
  // Legacy fallback for single-store setups
  if (LEGACY_ECWID_STORE_ID && LEGACY_ECWID_ACCESS_TOKEN) {
    return { storeId: LEGACY_ECWID_STORE_ID, accessToken: LEGACY_ECWID_ACCESS_TOKEN, publicToken: "" };
  }
  return { storeId: storeId || "", accessToken: "", publicToken: "" };
}

// ── Per-store settings helpers ──────────────────────────────────────────────
function getStoreSetting(storeId, key, defaultValue = '') {
  if (storeId) {
    const row = db.prepare('SELECT value FROM store_settings WHERE store_id = ? AND key = ?').get(storeId, key);
    if (row) return row.value;
  }
  // Fallback to global settings
  return getSetting(key, defaultValue);
}

function setStoreSetting(storeId, key, value) {
  if (storeId) {
    db.prepare(
      'INSERT INTO store_settings (store_id, key, value) VALUES (?, ?, ?) ON CONFLICT(store_id, key) DO UPDATE SET value = excluded.value'
    ).run(storeId, key, value);
  } else {
    setSetting(key, value);
  }
}

function normalizeBase64(input) {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return str;
}

function decryptEcwidPayload(payload) {
  if (!ECWID_CLIENT_SECRET) return null;
  const key = Buffer.from(ECWID_CLIENT_SECRET.substring(0, 16));
  const decoded = Buffer.from(normalizeBase64(payload), "base64");
  const iv = decoded.subarray(0, 16);
  const encrypted = decoded.subarray(16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  try {
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return null;
  }
}

app.use((req, res, next) => {
  req.ecwid = req.session?.ecwid || null;

  // Safari ITP fallback: if no session cookie, try the _t admin token
  if (!req.ecwid && (req.query._t || req.body?._t)) {
    const token = req.query._t || req.body._t;
    const storeId = verifyAdminToken(token);
    if (storeId) {
      const store = getStore(storeId);
      if (store) {
        req.ecwid = { store_id: store.store_id, access_token: store.access_token, public_token: store.public_token || "", lang: "" };
        // Try to restore the session for subsequent requests (may work in Chrome)
        req.session.ecwid = req.ecwid;
      }
    }
  }

  res.locals.ecwid = req.ecwid;
  res.locals.ecwidClientId = ECWID_CLIENT_ID;
  // Resolved public registry base URL: Ecwid storefront page if configured, else our own /registry
  res.locals.publicRegistryUrl = getPublicRegistryUrl() || (BASE_URL + "/registry");

  // Generate admin token for Safari ITP cookie-free auth propagation
  const adminStoreId = req.ecwid?.store_id;
  if (adminStoreId) {
    res.locals.adminToken = createAdminToken(adminStoreId);
  } else {
    res.locals.adminToken = "";
  }

  // Wrap res.redirect to auto-append _t token on admin routes
  const origRedirect = res.redirect.bind(res);
  res.redirect = function(statusOrUrl, maybeUrl) {
    // Express supports redirect(url) and redirect(status, url)
    let url = maybeUrl !== undefined ? maybeUrl : statusOrUrl;
    if (res.locals.adminToken && typeof url === "string" && url.startsWith("/admin")) {
      const sep = url.includes("?") ? "&" : "?";
      url = url + sep + "_t=" + encodeURIComponent(res.locals.adminToken);
    }
    if (maybeUrl !== undefined) return origRedirect(statusOrUrl, url);
    return origRedirect(url);
  };

  next();
});

function getRegistryById(id) {
  return db.prepare("SELECT * FROM registry WHERE id = ?").get(id);
}

/** Returns the registry only if it belongs to the given store (or storeId is absent). */
function getRegistryByIdForStore(id, storeId) {
  if (storeId) {
    return db.prepare("SELECT * FROM registry WHERE id = ? AND store_id = ?").get(id, storeId) || null;
  }
  return getRegistryById(id);
}

function getRegistryItemById(registryId, itemId) {
  return db
    .prepare("SELECT * FROM registry_item WHERE registry_id = ? AND id = ?")
    .get(registryId, itemId);
}

function getRegistryPurchaseById(registryId, purchaseId) {
  return db
    .prepare("SELECT * FROM registry_purchase WHERE registry_id = ? AND id = ?")
    .get(registryId, purchaseId);
}

function getRegistryItems(registryId) {
  return db
    .prepare(
      `
      SELECT ri.*,
        COALESCE(SUM(CASE WHEN COALESCE(rp.off_registry, 0) = 0 THEN rp.qty ELSE 0 END), 0) AS purchased_qty,
        MAX(
          ri.desired_qty - COALESCE(SUM(CASE WHEN COALESCE(rp.off_registry, 0) = 0 THEN rp.qty ELSE 0 END), 0),
          0
        ) AS still_needed
      FROM registry_item ri
      LEFT JOIN registry_purchase rp
        ON rp.registry_id = ri.registry_id
       AND rp.product_id = ri.product_id
      WHERE ri.registry_id = ?
      GROUP BY ri.id
      ORDER BY ri.id DESC
    `
    )
    .all(registryId);
}

function getRegistryPurchases(registryId) {
  return db
    .prepare(
      `
      SELECT
        rp.*,
        COALESCE(
          rp.product_name,
          (
            SELECT ri.product_name
            FROM registry_item ri
            WHERE ri.registry_id = rp.registry_id
              AND ri.product_id = rp.product_id
            ORDER BY ri.id DESC
            LIMIT 1
          )
        ) AS display_product_name,
        COALESCE(
          rp.product_sku,
          (
            SELECT ri.product_sku
            FROM registry_item ri
            WHERE ri.registry_id = rp.registry_id
              AND ri.product_id = rp.product_id
            ORDER BY ri.id DESC
            LIMIT 1
          )
        ) AS display_product_sku
      FROM registry_purchase rp
      WHERE rp.registry_id = ?
      ORDER BY rp.created_at DESC
    `
    )
    .all(registryId);
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// Resolved settings: DB value takes priority over env var
function getShippingFlatRate() {
  const dbVal = getSetting('shipping_flat_rate');
  return dbVal ? Number(dbVal) : SHIPPING_FLAT_RATE;
}

function getShippingFreeThreshold() {
  const dbVal = getSetting('shipping_free_threshold');
  return dbVal ? Number(dbVal) : SHIPPING_FREE_THRESHOLD;
}

function getPublicRegistryUrl() {
  return getSetting('public_registry_url') || PUBLIC_REGISTRY_URL || '';
}

function getRegistryPageUrl() {
  return getSetting('registry_page_url') || REGISTRY_PAGE_URL || '';
}

// Helpers for Ecwid API (optional)
async function fetchEcwidProduct(productId, storeId, accessToken) {
  if (!accessToken || !storeId || storeId === "STORE_ID_PLACEHOLDER") {
    return null;
  }
  const url = `https://app.ecwid.com/api/v3/${storeId}/products/${productId}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`[ecwid-api] fetch product failed status=${res.status} body=${body}`);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

async function searchEcwidProductsBySku(skuQuery, storeId, accessToken) {
  if (!accessToken || !storeId || storeId === "STORE_ID_PLACEHOLDER") {
    return { items: [], error: "Missing Ecwid API credentials." };
  }
  const url = `https://app.ecwid.com/api/v3/${storeId}/products?sku=${encodeURIComponent(skuQuery)}&limit=50`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`[ecwid-api] sku search failed status=${res.status} body=${body}`);
      return { items: [], error: `Ecwid search failed (${res.status}): ${body || "No details"}` };
    }
    const data = await res.json();
    const q = skuQuery.trim().toLowerCase();
    const items = Array.isArray(data?.items) ? data.items : [];
    const sorted = items
      .filter((item) => String(item?.sku || "").toLowerCase().includes(q))
      .sort((a, b) => {
        const aSku = String(a?.sku || "").toLowerCase();
        const bSku = String(b?.sku || "").toLowerCase();
        if (aSku === q && bSku !== q) return -1;
        if (bSku === q && aSku !== q) return 1;
        return 0;
      });
    return { items: sorted, error: null };
  } catch {
    return { items: [], error: "Could not reach Ecwid API." };
  }
}

async function fetchEcwidProductBySku(sku, storeId, accessToken) {
  const result = await searchEcwidProductsBySku(sku, storeId, accessToken);
  if (result.error) return { product: null, error: result.error };
  const needle = String(sku || "").trim().toLowerCase();
  const exact = result.items.find((item) => String(item?.sku || "").trim().toLowerCase() === needle);
  if (exact) return { product: exact, error: null };
  if (result.items.length > 0) return { product: result.items[0], error: null };
  return { product: null, error: "No Ecwid product found for that SKU." };
}

// ── Registrant portal auth middleware ─────────────────────────────────────────
function requireRegistrant(req, res, next) {
  if (!req.session.registrantId) return res.redirect("/portal/login");
  next();
}

// ── Ecwid iframe auth middleware ───────────────────────────────────────────────
function requireEcwid(req, res, next) {
  if (req.ecwid) return next();

  // Always try to bootstrap from the Ecwid payload query param when present.
  // This handles the case where the iframeUrl is configured as /admin
  // instead of /ecwid/iframe, or when the session cookie is lost.
  if (req.query.payload && ECWID_CLIENT_SECRET) {
    const data = decryptEcwidPayload(req.query.payload);
    if (data) {
      const storeId = String(data.store_id || data.storeId || "");
      const accessToken = data.access_token || data.accessToken || "";
      const publicToken = data.public_token || data.publicToken || "";
      req.session.ecwid = { store_id: storeId, access_token: accessToken, public_token: publicToken, lang: data.lang || "" };
      req.ecwid = req.session.ecwid;
      res.locals.ecwid = req.ecwid;
      if (storeId && accessToken) {
        upsertStore(storeId, accessToken, publicToken);
        deployCraneSection(storeId);
      }
      return next();
    }
  }

  if (ALLOW_NO_ECWID) {
    req.ecwid = { store_id: LEGACY_ECWID_STORE_ID, access_token: LEGACY_ECWID_ACCESS_TOKEN, public_token: "", lang: "" };
    res.locals.ecwid = req.ecwid;
    return next();
  }

  return res.status(401).send("This app must be opened from the Ecwid admin panel.");
}

// Short-lived signed token for cross-origin iframe bootstrap (avoids third-party cookie issues)
function createPortalToken(accountId) {
  const ts = Date.now();
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(`${accountId}:${ts}`).digest("hex");
  return `${accountId}_${ts}_${sig}`;
}
function verifyPortalToken(token) {
  try {
    const parts = String(token || "").split("_");
    if (parts.length !== 3) return null;
    const [idStr, tsStr, sig] = parts;
    const id = Number(idStr);
    const ts = Number(tsStr);
    if (!id || !ts) return null;
    if (Date.now() - ts > 15 * 60 * 1000) return null; // 15-minute expiry
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`${id}:${ts}`).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
    return db.prepare("SELECT * FROM registry_account WHERE id = ?").get(id) || null;
  } catch {
    return null;
  }
}

// ── Admin store token (cookie-free auth for Safari ITP) ───────────────────────
// Safari blocks third-party cookies in iframes, so we propagate store identity
// via a signed URL token (_t) instead of relying on session cookies.
function createAdminToken(storeId) {
  const ts = Date.now();
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(`admin:${storeId}:${ts}`).digest("hex");
  return `${storeId}_${ts}_${sig}`;
}
function verifyAdminToken(token) {
  try {
    const parts = String(token || "").split("_");
    if (parts.length !== 3) return null;
    const [storeId, tsStr, sig] = parts;
    const ts = Number(tsStr);
    if (!storeId || !ts) return null;
    if (Date.now() - ts > 2 * 60 * 60 * 1000) return null; // 2-hour expiry
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`admin:${storeId}:${ts}`).digest("hex");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
    return storeId;
  } catch {
    return null;
  }
}

// Native app iframe entrypoint
app.get("/ecwid/iframe", (req, res) => {
  // Allow Ecwid to embed this page in an iframe
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");

  const payload = req.query.payload;
  if (payload && ECWID_CLIENT_SECRET) {
    const data = decryptEcwidPayload(payload);
    if (!data) {
      console.log("[ecwid-iframe] payload decrypt failed — check ECWID_CLIENT_SECRET");
      return res.status(400).send("Invalid payload — ECWID_CLIENT_SECRET mismatch");
    }
    const storeId = String(data.store_id || data.storeId || "");
    const accessToken = data.access_token || data.accessToken || "";
    const publicToken = data.public_token || data.publicToken || "";
    console.log(`[ecwid-iframe] payload ok store_id=${storeId}`);
    req.session.ecwid = {
      store_id: storeId,
      access_token: accessToken,
      public_token: publicToken,
      lang: data.lang || ""
    };
    // Persist store credentials so they survive across sessions and are
    // available for webhooks, auto-sync, and other background tasks.
    if (storeId && accessToken) {
      upsertStore(storeId, accessToken, publicToken);
      console.log(`[ecwid-iframe] store ${storeId} credentials saved`);
      // Trigger crane deploy if it hasn't run yet — pass storeId directly
      deployCraneSection(storeId);
    }
  } else if (payload) {
    console.log("[ecwid-iframe] no ECWID_CLIENT_SECRET — skipping payload verification");
  }

  // Explicitly save the session so the cookie is guaranteed to be set in this
  // response before the admin HTML is sent (avoids timing issues with lazy-save).
  const storeId = req.session.ecwid?.store_id;
  // Generate admin token for this iframe session (Safari ITP workaround)
  if (storeId) {
    res.locals.adminToken = createAdminToken(storeId);
  }
  req.session.save(() => {
    let registries;
    if (storeId) {
      registries = db.prepare("SELECT * FROM registry WHERE store_id = ? ORDER BY created_at DESC").all(storeId);
    } else {
      registries = db.prepare("SELECT * FROM registry ORDER BY created_at DESC").all();
    }
    res.render("admin/index", { registries, actionError: null, actionInfo: null });
  });
});

// Allow all /admin routes to be embedded in the Ecwid iframe
app.use("/admin", (req, res, next) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  next();
});

// Admin routes — all require a valid Ecwid iframe session
app.use("/admin", requireEcwid);

app.get("/admin", (req, res) => {
  let registries = [];
  if (req.ecwid?.store_id) {
    registries = db
      .prepare("SELECT * FROM registry WHERE store_id = ? ORDER BY created_at DESC")
      .all(req.ecwid.store_id);
  } else {
    registries = db
      .prepare("SELECT * FROM registry ORDER BY created_at DESC")
      .all();
  }
  const actionError = req.query.error || null;
  const actionInfo = req.query.info || null;
  res.render("admin/index", { registries, actionError, actionInfo });
});


app.get("/admin/registry/new", (req, res) => {
  res.render("admin/new");
});

app.post("/admin/registry", (req, res) => {
  const { display_name, event_date } = req.body;
  const storeId = req.ecwid.store_id;
  const type = "online";
  const stmt = db.prepare(
    "INSERT INTO registry (display_name, event_date, registry_type, store_id) VALUES (?, ?, ?, ?)"
  );
  const info = stmt.run(display_name?.trim(), event_date || null, type, storeId);
  res.redirect(`/admin/registry/${info.lastInsertRowid}`);
});

app.get("/admin/registry/:id", async (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");
  const items = getRegistryItems(registryId);
  const purchases = getRegistryPurchases(registryId);
  const skuSearch = String(req.query.sku || "").trim();
  const actionError = String(req.query.error || "").trim();
  const actionInfo = String(req.query.info || "").trim();
  let skuResults = [];
  let skuError = null;
  if (skuSearch) {
    const creds = resolveStoreCredentials(req.ecwid?.store_id || registry.store_id);
    const result = await searchEcwidProductsBySku(skuSearch, creds.storeId, creds.accessToken);
    skuResults = result.items;
    skuError = result.error;
  }
  const registrantAccount = db
    .prepare("SELECT * FROM registry_account WHERE registry_id = ?")
    .get(registryId) || null;
  const portalLoginUrl = `${BASE_URL}/portal/login`;
  const portalWidgetUrl = `${BASE_URL}/widget/portal.js`;
  const cartWidgetUrl = `${BASE_URL}/widget/cart.js`;
  const ecwidStoreId = req.ecwid.store_id || registry.store_id;
  res.render("admin/detail", { registry, items, purchases, skuSearch, skuResults, skuError, actionError, actionInfo, registrantAccount, portalLoginUrl, portalWidgetUrl, cartWidgetUrl, ecwidStoreId });
});

app.post("/admin/registry/:id/edit", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");
  const name = String(req.body.display_name || "").trim();
  if (!name) {
    const msg = encodeURIComponent("Registry name cannot be empty.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  const date = String(req.body.event_date || "").trim() || null;
  const description = String(req.body.description || "").trim() || null;
  db.prepare(
    "UPDATE registry SET display_name = ?, event_date = ?, description = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name, date, description, registryId);
  const msg = encodeURIComponent("Registry updated.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/shipping", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");
  const method = req.body.shipping_method === "ship_to_registrant" ? "ship_to_registrant" : "pickup";
  const address = method === "ship_to_registrant" ? String(req.body.shipping_address || "").trim() : null;
  db.prepare(
    "UPDATE registry SET shipping_method = ?, shipping_address = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(method, address, registryId);
  const msg = encodeURIComponent("Shipping settings updated.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

// ── Settings page ─────────────────────────────────────────────────────────────
app.get("/admin/settings", (req, res) => {
  const storeId = req.ecwid.store_id;
  const creds = resolveStoreCredentials(storeId);
  const settings = {
    shippingFlatRate: storeId ? Number(getStoreSetting(storeId, 'shipping_flat_rate') || getShippingFlatRate()) : getShippingFlatRate(),
    shippingFreeThreshold: storeId ? Number(getStoreSetting(storeId, 'shipping_free_threshold') || getShippingFreeThreshold()) : getShippingFreeThreshold(),
    publicRegistryUrl: storeId ? (getStoreSetting(storeId, 'public_registry_url') || getPublicRegistryUrl()) : getPublicRegistryUrl(),
    registryPageUrl: storeId ? (getStoreSetting(storeId, 'registry_page_url') || getRegistryPageUrl()) : getRegistryPageUrl(),
    ecwidStoreId: storeId,
    ecwidClientId: ECWID_CLIENT_ID,
    hasAccessToken: !!creds.accessToken,
    hasClientSecret: !!ECWID_CLIENT_SECRET,
    baseUrl: BASE_URL,
    nodeEnv: process.env.NODE_ENV || 'development',
  };

  const webhooks = {
    orderCreated: `${BASE_URL}/webhooks/ecwid/order-created`,
    shipping: `${BASE_URL}/webhooks/ecwid/shipping`,
  };

  const actionError = req.query.error || null;
  const actionInfo = req.query.info || null;

  res.render("admin/settings", { settings, webhooks, actionError, actionInfo });
});

app.post("/admin/settings", (req, res) => {
  const { shipping_flat_rate, shipping_free_threshold, public_registry_url, registry_page_url } = req.body;

  const flatRate = Number(shipping_flat_rate);
  if (isNaN(flatRate) || flatRate < 0) {
    return res.redirect("/admin/settings?error=" + encodeURIComponent("Shipping flat rate must be a non-negative number."));
  }
  const freeThreshold = Number(shipping_free_threshold);
  if (isNaN(freeThreshold) || freeThreshold < 0) {
    return res.redirect("/admin/settings?error=" + encodeURIComponent("Free threshold must be a non-negative number."));
  }

  const saveStoreId = req.ecwid.store_id;
  setStoreSetting(saveStoreId, 'shipping_flat_rate', String(flatRate));
  setStoreSetting(saveStoreId, 'shipping_free_threshold', String(freeThreshold));
  setStoreSetting(saveStoreId, 'public_registry_url', String(public_registry_url || '').trim());
  setStoreSetting(saveStoreId, 'registry_page_url', String(registry_page_url || '').trim());

  return res.redirect("/admin/settings?info=" + encodeURIComponent("Settings saved."));
});

app.post("/admin/registry/:id/items", async (req, res) => {
  const registryId = Number(req.params.id);
  const { product_id, product_name, product_sku, desired_qty } = req.body;
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");
  const creds = resolveStoreCredentials(req.ecwid?.store_id || registry.store_id);
  let productId = Number(product_id || 0);
  let name = product_name?.trim() || null;
  let sku = product_sku?.trim() || null;
  let thumbnail = null;

  if (!productId && sku) {
    const bySku = await fetchEcwidProductBySku(sku, creds.storeId, creds.accessToken);
    if (!bySku.product) {
      const msg = encodeURIComponent(bySku.error || "Could not find product by SKU.");
      return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
    }
    productId = Number(bySku.product.id);
    if (!name) name = bySku.product.name || null;
    if (!sku) sku = bySku.product.sku || null;
    if (!thumbnail) thumbnail = bySku.product.thumbnailUrl || null;
  }

  if (productId && (!name || !sku)) {
    const product = await fetchEcwidProduct(productId, creds.storeId, creds.accessToken);
    if (product) {
      if (!name) name = product.name || null;
      if (!sku) sku = product.sku || null;
      if (!thumbnail) thumbnail = product.thumbnailUrl || null;
    }
  }

  if (!productId) {
    const msg = encodeURIComponent("Please provide a valid SKU.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }

  const desiredQty = Number(desired_qty || 1);
  if (!Number.isInteger(desiredQty) || desiredQty < 1) {
    const msg = encodeURIComponent("Desired quantity must be at least 1.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  const existingItem = db
    .prepare("SELECT * FROM registry_item WHERE registry_id = ? AND product_id = ? ORDER BY id DESC LIMIT 1")
    .get(registryId, productId);
  if (existingItem) {
    db.prepare(
      "UPDATE registry_item SET desired_qty = ?, product_name = ?, product_sku = ?, product_thumbnail = ? WHERE id = ?"
    ).run(
      existingItem.desired_qty + desiredQty,
      name || existingItem.product_name,
      sku || existingItem.product_sku,
      thumbnail || existingItem.product_thumbnail,
      existingItem.id
    );
    const msg = encodeURIComponent("Item already existed. Desired quantity was increased.");
    return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
  }

  db.prepare(
    "INSERT INTO registry_item (registry_id, product_id, product_name, product_sku, desired_qty, product_thumbnail) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(registryId, productId, name, sku, desiredQty, thumbnail);
  res.redirect(`/admin/registry/${registryId}`);
});

app.post("/admin/registry/:id/items/:itemId/quantity", (req, res) => {
  const registryId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const desiredQty = Number(req.body.desired_qty || 0);
  const item = getRegistryItemById(registryId, itemId);
  if (!item) {
    const msg = encodeURIComponent("Registry item not found.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  if (!Number.isInteger(desiredQty) || desiredQty < 1) {
    const msg = encodeURIComponent("Desired quantity must be at least 1.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  db.prepare("UPDATE registry_item SET desired_qty = ? WHERE id = ?").run(desiredQty, itemId);
  const msg = encodeURIComponent("Quantity updated.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/items/:itemId/delete", (req, res) => {
  const registryId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const item = getRegistryItemById(registryId, itemId);
  if (!item) {
    const msg = encodeURIComponent("Registry item not found.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  db.prepare("DELETE FROM registry_item WHERE id = ?").run(itemId);
  const msg = encodeURIComponent("Item removed from registry.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/purchases", (req, res) => {
  const registryId = Number(req.params.id);
  const { product_id, qty, buyer_name, buyer_email, notes, channel } = req.body;
  const productId = Number(product_id || 0);
  const quantity = Number(qty || 0);
  if (!productId) {
    const msg = encodeURIComponent("Please choose an item from this registry.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  if (!Number.isInteger(quantity) || quantity === 0) {
    const msg = encodeURIComponent("Quantity must be a whole number and cannot be 0.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  const item = db
    .prepare("SELECT product_name, product_sku FROM registry_item WHERE registry_id = ? AND product_id = ? ORDER BY id DESC LIMIT 1")
    .get(registryId, productId);
  db.prepare(
    "INSERT INTO registry_purchase (registry_id, product_id, product_name, product_sku, qty, buyer_name, buyer_email, notes, off_registry, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    registryId,
    productId,
    item?.product_name || null,
    item?.product_sku || null,
    quantity,
    buyer_name?.trim() || null,
    buyer_email?.trim() || null,
    notes?.trim() || null,
    0,
    channel || "in_store"
  );
  res.redirect(`/admin/registry/${registryId}`);
});

app.post("/admin/registry/:id/purchases/off-registry", (req, res) => {
  const registryId = Number(req.params.id);
  const { product_name, product_sku, qty, buyer_name, buyer_email, notes } = req.body;
  const quantity = Number(qty || 0);
  const itemName = String(product_name || "").trim();
  if (!itemName) {
    const msg = encodeURIComponent("Off-registry purchase requires an item name.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  if (!Number.isInteger(quantity) || quantity === 0) {
    const msg = encodeURIComponent("Quantity must be a whole number and cannot be 0.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  db.prepare(
    "INSERT INTO registry_purchase (registry_id, product_id, product_name, product_sku, qty, buyer_name, buyer_email, notes, off_registry, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    registryId,
    0,
    itemName,
    String(product_sku || "").trim() || null,
    quantity,
    String(buyer_name || "").trim() || null,
    String(buyer_email || "").trim() || null,
    String(notes || "").trim() || null,
    1,
    "off_registry"
  );
  const msg = encodeURIComponent("Off-registry purchase recorded.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/purchases/:purchaseId/update", (req, res) => {
  const registryId = Number(req.params.id);
  const purchaseId = Number(req.params.purchaseId);
  const purchase = getRegistryPurchaseById(registryId, purchaseId);
  if (!purchase) {
    const msg = encodeURIComponent("Purchase record not found.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }

  const quantity = Number(req.body.qty || 0);
  if (!Number.isInteger(quantity) || quantity === 0) {
    const msg = encodeURIComponent("Quantity must be a whole number and cannot be 0.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }

  const updatedName = String(req.body.product_name || "").trim() || null;
  const updatedSku = String(req.body.product_sku || "").trim() || null;
  if (purchase.off_registry && !updatedName) {
    const msg = encodeURIComponent("Off-registry purchase requires an item name.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  const safeName = purchase.off_registry ? updatedName : purchase.product_name;
  const safeSku = purchase.off_registry ? updatedSku : purchase.product_sku;

  db.prepare(
    `
      UPDATE registry_purchase
      SET product_name = ?,
          product_sku = ?,
          qty = ?,
          buyer_name = ?,
          buyer_email = ?,
          notes = ?
      WHERE id = ? AND registry_id = ?
    `
  ).run(
    safeName,
    safeSku,
    quantity,
    String(req.body.buyer_name || "").trim() || null,
    String(req.body.buyer_email || "").trim() || null,
    String(req.body.notes || "").trim() || null,
    purchaseId,
    registryId
  );

  const msg = encodeURIComponent("Purchase updated.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/purchases/:purchaseId/delete", (req, res) => {
  const registryId = Number(req.params.id);
  const purchaseId = Number(req.params.purchaseId);
  const purchase = getRegistryPurchaseById(registryId, purchaseId);
  if (!purchase) {
    const msg = encodeURIComponent("Purchase record not found.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  db.prepare("DELETE FROM registry_purchase WHERE id = ? AND registry_id = ?").run(purchaseId, registryId);
  const msg = encodeURIComponent("Purchase deleted.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/archive", (req, res) => {
  const registryId = Number(req.params.id);
  db.prepare("UPDATE registry SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(registryId);
  res.redirect("/admin");
});

app.post("/admin/registry/:id/photo", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");
  const photo = String(req.body.photo_data || "").trim() || null;
  // Validate it looks like a data URL (data:image/...) or is empty (to remove)
  if (photo && !photo.startsWith("data:image/")) {
    const msg = encodeURIComponent("Invalid image format.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  db.prepare("UPDATE registry SET photo = ?, updated_at = datetime('now') WHERE id = ?").run(photo, registryId);
  const msg = photo ? encodeURIComponent("Photo updated.") : encodeURIComponent("Photo removed.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.get("/admin/registry/:id/print", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");
  const items = getRegistryItems(registryId);
  res.render("admin/print", { registry, items });
});

// ── Registrant account management (admin) ─────────────────────────────────────
app.post("/admin/registry/:id/account", async (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");

  const name = String(req.body.name || "").trim() || null;
  const email = String(req.body.email || "").trim().toLowerCase();
  const canAddItems = req.body.can_add_items ? 1 : 0;

  if (!email) {
    const msg = encodeURIComponent("Email is required.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }

  const existing = db.prepare("SELECT id FROM registry_account WHERE registry_id = ?").get(registryId);
  if (existing) {
    const msg = encodeURIComponent("An account already exists for this registry.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }

  // Try to look up the Ecwid customer ID for this email (best-effort)
  let ecwidCustomerId = null;
  const acctCreds = resolveStoreCredentials(req.ecwid?.store_id || registry.store_id);
  if (acctCreds.accessToken && acctCreds.storeId) {
    try {
      const url = `https://app.ecwid.com/api/v3/${acctCreds.storeId}/customers?email=${encodeURIComponent(email)}&limit=1`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${acctCreds.accessToken}` } });
      if (resp.ok) {
        const data = await resp.json();
        if (data.items && data.items.length > 0) {
          ecwidCustomerId = String(data.items[0].id);
        }
      }
    } catch {
      // non-fatal — proceed without customer ID
    }
  }

  // password_hash column still exists for schema compat; store empty placeholder
  db.prepare(
    "INSERT INTO registry_account (registry_id, name, email, password_hash, can_add_items, ecwid_customer_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(registryId, name, email, "", canAddItems, ecwidCustomerId);

  const msg = encodeURIComponent("Registrant account linked.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/account/toggle-items", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");

  const account = db.prepare("SELECT id, can_add_items FROM registry_account WHERE registry_id = ?").get(registryId);
  if (!account) {
    const msg = encodeURIComponent("No account found for this registry.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }

  const newVal = account.can_add_items ? 0 : 1;
  db.prepare("UPDATE registry_account SET can_add_items = ? WHERE registry_id = ?").run(newVal, registryId);

  const msg = encodeURIComponent(newVal ? "Registrant can now add items." : "Registrant can no longer add items.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/account/delete", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryByIdForStore(registryId, req.ecwid?.store_id);
  if (!registry) return res.status(404).send("Not found");

  db.prepare("DELETE FROM registry_account WHERE registry_id = ?").run(registryId);

  const msg = encodeURIComponent("Registrant account deleted.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

// ── Registrant portal ─────────────────────────────────────────────────────────

// Allow cross-origin preflight for portal login (used by Ecwid storefront inline embed)
app.options("/portal/login", (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  }
  res.status(204).end();
});

app.get("/portal/login", (req, res) => {
  if (req.session.registrantId) return res.redirect("/portal");
  const error = String(req.query.error || "").trim();
  res.render("portal/login", { error, ecwidStoreId: req.query.store_id || LEGACY_ECWID_STORE_ID || "" });
});

// Accepts email from either Ecwid SSO page (form POST) or widget inline embed (JSON fetch)
app.post("/portal/login", (req, res) => {
  // CORS for cross-origin fetch calls from the Ecwid storefront
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  const isJson = !!(
    req.headers.accept?.includes("application/json") ||
    req.headers["content-type"]?.includes("application/json")
  );

  const email = String(req.body.email || "").trim().toLowerCase();

  if (!email) {
    if (isJson) return res.json({ ok: false, error: "No email provided." });
    const msg = encodeURIComponent("No email received from Ecwid.");
    return res.redirect(`/portal/login?error=${msg}`);
  }

  const account = db.prepare("SELECT * FROM registry_account WHERE LOWER(email) = ?").get(email);
  if (!account) {
    if (isJson) return res.json({ ok: false, error: "No registry is linked to this Ecwid account." });
    const msg = encodeURIComponent("No registry is linked to this Ecwid account. Please contact the store.");
    return res.redirect(`/portal/login?error=${msg}`);
  }

  req.session.registrantId = account.id;
  if (isJson) return res.json({ ok: true, token: createPortalToken(account.id) });
  return res.redirect("/portal");
});

app.get("/portal/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/portal/login");
  });
});

app.get("/portal", (req, res) => {
  // Allow bootstrapping the session via a short-lived signed token (used by the Ecwid
  // storefront embed to avoid third-party cookie restrictions).
  if (!req.session.registrantId && req.query.token) {
    const account = verifyPortalToken(req.query.token);
    if (account) {
      req.session.registrantId = account.id;
      // Redirect to /portal without the token in the URL (clean URL + prevents reuse)
      return res.redirect("/portal");
    }
  }
  if (!req.session.registrantId) return res.redirect("/portal/login");

  const account = db.prepare("SELECT * FROM registry_account WHERE id = ?").get(req.session.registrantId);
  if (!account) {
    req.session.destroy(() => res.redirect("/portal/login"));
    return;
  }
  const registry = getRegistryById(account.registry_id);
  if (!registry) {
    const msg = encodeURIComponent("Registry not found.");
    return res.redirect(`/portal/login?error=${msg}`);
  }
  const items = getRegistryItems(account.registry_id);
  const purchases = getRegistryPurchases(account.registry_id);
  const actionInfo = String(req.query.info || "").trim();
  const actionError = String(req.query.error || "").trim();
  res.render("portal/index", { account, registry, items, purchases, actionInfo, actionError });
});

app.post("/portal/items", requireRegistrant, async (req, res) => {
  const account = db.prepare("SELECT * FROM registry_account WHERE id = ?").get(req.session.registrantId);
  if (!account) return res.redirect("/portal/login");
  if (!account.can_add_items) {
    const msg = encodeURIComponent("You do not have permission to add items.");
    return res.redirect(`/portal?error=${msg}`);
  }

  const registryId = account.registry_id;
  const itemName = String(req.body.product_name || "").trim();
  const sku = String(req.body.product_sku || "").trim() || null;
  const desiredQty = Number(req.body.desired_qty || 1);

  if (!itemName) {
    const msg = encodeURIComponent("Item name is required.");
    return res.redirect(`/portal?error=${msg}`);
  }
  if (!Number.isInteger(desiredQty) || desiredQty < 1) {
    const msg = encodeURIComponent("Quantity must be at least 1.");
    return res.redirect(`/portal?error=${msg}`);
  }

  let productId = 0;
  let finalName = itemName;
  let finalSku = sku;

  if (sku) {
    const registry = getRegistryById(registryId);
    const portalCreds = resolveStoreCredentials(registry?.store_id);
    const result = await fetchEcwidProductBySku(sku, portalCreds.storeId, portalCreds.accessToken);
    if (result.product) {
      productId = Number(result.product.id);
      finalName = result.product.name || itemName;
      finalSku = result.product.sku || sku;
    }
  }

  const existingItem = db
    .prepare("SELECT * FROM registry_item WHERE registry_id = ? AND product_id = ? AND product_id != 0 ORDER BY id DESC LIMIT 1")
    .get(registryId, productId);

  if (productId && existingItem) {
    db.prepare(
      "UPDATE registry_item SET desired_qty = ?, product_name = ?, product_sku = ? WHERE id = ?"
    ).run(
      existingItem.desired_qty + desiredQty,
      finalName || existingItem.product_name,
      finalSku || existingItem.product_sku,
      existingItem.id
    );
    const msg = encodeURIComponent("Item already on registry — desired quantity increased.");
    return res.redirect(`/portal?info=${msg}`);
  }

  db.prepare(
    "INSERT INTO registry_item (registry_id, product_id, product_name, product_sku, desired_qty) VALUES (?, ?, ?, ?, ?)"
  ).run(registryId, productId, finalName, finalSku, desiredQty);

  const msg = encodeURIComponent("Item added to registry.");
  return res.redirect(`/portal?info=${msg}`);
});

// Public pages
app.get("/registry", (req, res) => {
  const storeId = req.query.store_id || LEGACY_ECWID_STORE_ID || "";
  res.render("public/registry", { baseUrl: BASE_URL, storeId });
});

app.get("/registry/:id", (req, res) => {
  const registryId = Number(req.params.id);
  const storeId = req.query.store_id || LEGACY_ECWID_STORE_ID || "";
  res.render("public/registry-detail", { baseUrl: BASE_URL, registryId, storeId });
});

app.get("/registry-embed", (req, res) => {
  const storeId = req.query.store_id || LEGACY_ECWID_STORE_ID || "";
  res.render("public/registry-embed", { storeId });
});

// API endpoints for storefront widget
app.get("/api/registries", (req, res) => {
  const storeId = req.query.store_id;
  const q = String(req.query.q || "").trim();
  const params = [];
  let where = "WHERE r.status = 'active'";
  if (storeId) {
    where += " AND r.store_id = ?";
    params.push(storeId);
  }
  if (q) {
    where += " AND r.display_name LIKE ?";
    params.push(`%${q}%`);
  }
  const sql = `
    SELECT r.id, r.display_name, r.event_date, r.registry_type,
           COUNT(ri.id) as item_count
    FROM registry r
    LEFT JOIN registry_item ri ON ri.registry_id = r.id
    ${where}
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.get("/api/registries/:id", async (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryById(registryId);
  if (!registry || registry.status !== "active") return res.status(404).json({ error: "Not found" });
  const items = getRegistryItems(registryId);

  // Backfill thumbnails for items added before the product_thumbnail column existed
  const missingThumb = items.filter(item => !item.product_thumbnail && item.product_id);
  if (missingThumb.length > 0) {
    const creds = resolveStoreCredentials(registry.store_id);
    await Promise.all(missingThumb.map(async (item) => {
      const product = await fetchEcwidProduct(item.product_id, creds.storeId, creds.accessToken);
      if (product?.thumbnailUrl) {
        db.prepare("UPDATE registry_item SET product_thumbnail = ? WHERE id = ?")
          .run(product.thumbnailUrl, item.id);
        item.product_thumbnail = product.thumbnailUrl;
      }
    }));
  }

  // registry_type is already on the registry row from getRegistryById
  res.json({ registry, items });
});

// ─── Process a full Ecwid order: match items to registries, record purchases,
// and annotate the Ecwid order with staff notes. Used by both the webhook and
// the manual sync endpoint.
async function processEcwidOrder(order, { storeId: orderStoreId, accessToken: orderAccessToken } = {}) {
  const orderNumber = Number(order.orderNumber || order.vendorOrderNumber || order.id || 0);
  if (!orderNumber) return { recorded: 0, error: "no order number" };

  const extraFields = order?.orderExtraFields || [];
  const registryIdField = extraFields.find(
    (f) => f.key === "registry_id" || f.fieldKey === "registry_id" || f.id === "registry_id" || f.name === "registry_id"
  );
  const hintRegistryId = registryIdField
    ? Number(registryIdField.value || registryIdField.text || registryIdField.valueText)
    : null;

  // Parse per-item registry allocations from cart.js (v8+)
  // Format: { "productId": [{ rid: number, qty: number }] }
  let registryAllocations = null;
  const registryDataField = extraFields.find(
    (f) => f.key === "registry_data" || f.fieldKey === "registry_data" || f.id === "registry_data" || f.name === "registry_data"
  );
  if (registryDataField) {
    try {
      registryAllocations = JSON.parse(registryDataField.value || registryDataField.text || registryDataField.valueText || '{}');
    } catch(e) { /* ignore parse errors */ }
  }

  const orderItems = Array.isArray(order.items) ? order.items : [];
  if (!orderItems.length) return { recorded: 0, error: "no items" };

  let recorded = 0;
  const matchedRegistries = new Set();
  const matchedProductIds = new Set();

  for (const item of orderItems) {
    const productId = Number(item.productId);
    if (!productId) continue;

    const matchQuery = hintRegistryId
      ? "SELECT ri.registry_id FROM registry_item ri JOIN registry r ON ri.registry_id = r.id WHERE ri.product_id = ? AND ri.registry_id = ? AND r.status = 'active'"
      : "SELECT ri.registry_id FROM registry_item ri JOIN registry r ON ri.registry_id = r.id WHERE ri.product_id = ? AND r.status = 'active'";
    const matchParams = hintRegistryId ? [productId, hintRegistryId] : [productId];
    const matches = db.prepare(matchQuery).all(...matchParams);

    for (const match of matches) {
      matchedProductIds.add(productId);
      const registryId = match.registry_id;
      matchedRegistries.add(registryId); // Always track for annotation, even if already recorded

      const dup = db
        .prepare("SELECT id FROM registry_purchase WHERE order_id = ? AND product_id = ? AND registry_id = ?")
        .get(orderNumber, productId, registryId);
      if (dup) continue;

      // Use per-item registry allocation qty if available (from cart.js v8+),
      // otherwise fall back to the full order line item quantity
      let recordQty = Number(item.quantity || 1);
      if (registryAllocations && registryAllocations[String(productId)]) {
        const alloc = registryAllocations[String(productId)].find(a => a.rid === registryId);
        if (alloc && alloc.qty > 0) recordQty = alloc.qty;
      }

      db.prepare(
        "INSERT INTO registry_purchase (registry_id, product_id, product_name, product_sku, qty, buyer_name, buyer_email, notes, off_registry, channel, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        registryId, productId,
        item.name || null, item.sku || null,
        recordQty,
        order.billingPerson?.name || order.shippingPerson?.name || null,
        order.email || null,
        null, 0, "online", orderNumber
      );
      recorded++;
    }
  }

  // Annotate the Ecwid order with per-item and order-level notes
  // Resolve credentials for annotation: use passed-in creds, or look up from the first matched registry's store
  let annotateStoreId = orderStoreId || "";
  let annotateToken = orderAccessToken || "";
  if (!annotateToken && matchedRegistries.size > 0) {
    const firstReg = db.prepare("SELECT store_id FROM registry WHERE id = ?").get([...matchedRegistries][0]);
    if (firstReg?.store_id) {
      const creds = resolveStoreCredentials(firstReg.store_id);
      annotateStoreId = creds.storeId;
      annotateToken = creds.accessToken;
    }
  }
  if (matchedRegistries.size > 0 && annotateToken && annotateStoreId) {
    try {
      // Fetch full registry info (name, shipping_method, shipping_address) for each matched registry
      const regInfoMap = new Map();
      for (const rid of matchedRegistries) {
        const reg = db.prepare("SELECT id, display_name, shipping_method, shipping_address FROM registry WHERE id = ?").get(rid);
        if (reg) regInfoMap.set(rid, reg);
      }

      // Build a map of productId → [{ registryId, registryName }] for per-item labeling
      const productRegistryMap = new Map();
      for (const item of orderItems) {
        const pid = Number(item.productId);
        if (!matchedProductIds.has(pid)) continue;
        if (registryAllocations && registryAllocations[String(pid)]) {
          for (const alloc of registryAllocations[String(pid)]) {
            if (regInfoMap.has(alloc.rid)) {
              if (!productRegistryMap.has(pid)) productRegistryMap.set(pid, []);
              productRegistryMap.get(pid).push({ rid: alloc.rid, qty: alloc.qty });
            }
          }
        } else {
          // Fallback: associate with all matched registries
          for (const rid of matchedRegistries) {
            if (regInfoMap.has(rid)) {
              if (!productRegistryMap.has(pid)) productRegistryMap.set(pid, []);
              productRegistryMap.get(pid).push({ rid, qty: Number(item.quantity || 1) });
            }
          }
        }
      }

      // ── Staff notes (privateAdminNotes) ──
      const regNames = [...regInfoMap.values()].map(r => r.display_name);
      const giftItemNames = orderItems
        .filter(it => matchedProductIds.has(Number(it.productId)))
        .map(it => it.name || it.sku || `#${it.productId}`);

      let staffNote = `GIFT REGISTRY ORDER — ${regNames.join(", ")}\nRegistry items: ${giftItemNames.join(", ")}`;

      // Add shipping instructions per registry
      const shippingLines = [];
      for (const [, reg] of regInfoMap) {
        if (reg.shipping_method === "ship_to_registrant" && reg.shipping_address) {
          shippingLines.push(`• ${reg.display_name} — SHIP TO REGISTRANT: ${reg.shipping_address}`);
        } else {
          shippingLines.push(`• ${reg.display_name} — IN-STORE PICKUP`);
        }
      }
      staffNote += `\n\nSHIPPING INSTRUCTIONS:\n${shippingLines.join("\n")}`;

      // ── Customer notes (orderComments) ──
      const customerLines = [];
      for (const item of orderItems) {
        const pid = Number(item.productId);
        const prMap = productRegistryMap.get(pid);
        if (!prMap) continue;
        const itemName = item.name || item.sku || `#${item.productId}`;
        for (const entry of prMap) {
          const reg = regInfoMap.get(entry.rid);
          if (reg) customerLines.push(`• ${itemName} — ${reg.display_name}`);
        }
      }
      let customerNote = "";
      if (customerLines.length > 0) {
        customerNote = `🎁 This order contains gift registry items:\n${customerLines.join("\n")}\n\nItems listed above will be recorded as purchased on their registries. Thank you for your gift!`;
      }

      // ── Build per-item detail lines for staff notes ──
      const itemDetailLines = [];
      for (const item of orderItems) {
        const pid = Number(item.productId);
        const prMap = productRegistryMap.get(pid);
        if (!prMap || prMap.length === 0) continue;
        const itemName = item.name || item.sku || `#${pid}`;
        for (const entry of prMap) {
          const reg = regInfoMap.get(entry.rid);
          if (!reg) continue;
          const shippingLabel = reg.shipping_method === "ship_to_registrant" ? "Ship to registrant" : "Pickup in store";
          itemDetailLines.push(`• ${itemName} (qty ${entry.qty}) — ${reg.display_name} — ${shippingLabel}`);
        }
      }
      if (itemDetailLines.length > 0) {
        staffNote += `\n\nITEM DETAILS:\n${itemDetailLines.join("\n")}`;
      }

      // ── PUT order-level notes to Ecwid ──
      // (Per-item notes not supported by Ecwid API — all info goes in order-level fields)
      const url = `https://app.ecwid.com/api/v3/${annotateStoreId}/orders/${orderNumber}`;
      const putBody = { privateAdminNotes: staffNote };
      if (customerNote) putBody.orderComments = customerNote;

      console.log(`[order] #${orderNumber} — sending PUT to ${url}`);
      console.log(`[order] #${orderNumber} — staffNote length: ${staffNote.length}, customerNote length: ${customerNote.length}`);

      const resp = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${annotateToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(putBody)
      });

      const respText = await resp.text().catch(() => "");
      console.log(`[order] #${orderNumber} — PUT response: ${resp.status} ${resp.statusText} — ${respText}`);

      if (resp.ok) {
        console.log(`[order] #${orderNumber} — annotated ${giftItemNames.length} registry item(s): ${giftItemNames.join(", ")}`);
      } else {
        console.log(`[order] #${orderNumber} — annotation PUT FAILED: ${resp.status}`);
      }
    } catch (err) {
      console.log(`[order] #${orderNumber} — annotation error: ${err.message}`);
    }
  }

  return { recorded, registries: [...matchedRegistries] };
}

// ─── Custom Shipping Handler ─────────────────────────────────────────────────
// Ecwid POSTs cart data here so we can exclude "pickup in store" registry items
// from shipping cost calculations. Must respond within 10 seconds.
app.post("/webhooks/ecwid/shipping", express.json(), (req, res) => {
  try {
    const cart = req.body?.cart || req.body;
    const items = cart?.items || [];
    const shippingStoreId = String(req.body?.storeId || cart?.storeId || "");

    // Identify which items are registry pickup items
    let nonPickupSubtotal = 0;
    let hasPickupRegistryItems = false;
    let hasShippableItems = false;

    for (const item of items) {
      const productId = Number(item.productId || item.id);
      if (!productId) {
        // Unknown item — treat as shippable
        nonPickupSubtotal += Number(item.price || 0) * Number(item.quantity || 1);
        hasShippableItems = true;
        continue;
      }

      // Check if this product is in any active registry
      const regMatch = db.prepare(
        `SELECT r.shipping_method FROM registry_item ri
         JOIN registry r ON ri.registry_id = r.id
         WHERE ri.product_id = ? AND r.status = 'active'
         LIMIT 1`
      ).get(productId);

      if (regMatch && regMatch.shipping_method === "pickup") {
        // Registry item with in-store pickup — exclude from shipping
        hasPickupRegistryItems = true;
      } else {
        // Regular item or registry item that ships to registrant
        nonPickupSubtotal += Number(item.price || 0) * Number(item.quantity || 1);
        hasShippableItems = true;
      }
    }

    const shippingOptions = [];
    const flatRate = shippingStoreId
      ? Number(getStoreSetting(shippingStoreId, 'shipping_flat_rate') || getShippingFlatRate())
      : getShippingFlatRate();
    const freeThreshold = shippingStoreId
      ? Number(getStoreSetting(shippingStoreId, 'shipping_free_threshold') || getShippingFreeThreshold())
      : getShippingFreeThreshold();

    // Check free shipping threshold
    const freeShippingMet = freeThreshold > 0 && nonPickupSubtotal >= freeThreshold;

    if (!hasShippableItems && hasPickupRegistryItems) {
      // ALL items are pickup registry items → $0 shipping
      shippingOptions.push({
        title: "In-Store Pickup (Registry Items)",
        rate: 0,
        transitDays: "",
        description: "Registry items available for in-store pickup"
      });
    } else if (hasShippableItems && hasPickupRegistryItems) {
      // Mixed order — some pickup registry items, some regular
      if (freeShippingMet) {
        shippingOptions.push({
          title: "Free Shipping",
          rate: 0,
          transitDays: "5-7",
          description: `Free shipping on orders over $${freeThreshold}. Registry pickup items excluded from shipping.`
        });
      } else {
        shippingOptions.push({
          title: "Standard Shipping",
          rate: flatRate,
          transitDays: "3-5",
          description: "Shipping for non-registry items. Registry items available for in-store pickup."
        });
      }
      // Always offer pickup option for mixed orders
      shippingOptions.push({
        title: "In-Store Pickup (All Items)",
        rate: 0,
        transitDays: "",
        description: "Pick up all items in store"
      });
    } else {
      // No registry pickup items — normal shipping
      if (freeShippingMet) {
        shippingOptions.push({
          title: "Free Shipping",
          rate: 0,
          transitDays: "5-7",
          description: `Free shipping on orders over $${freeThreshold}`
        });
      } else {
        shippingOptions.push({
          title: "Standard Shipping",
          rate: flatRate,
          transitDays: "3-5",
          description: "Standard delivery"
        });
      }
    }

    console.log(`[shipping] ${items.length} item(s) — pickup: ${hasPickupRegistryItems}, shippable: ${hasShippableItems}, subtotal: $${nonPickupSubtotal.toFixed(2)}`);
    return res.json({ shippingOptions });
  } catch (err) {
    console.log(`[shipping] error: ${err.message}`);
    // Return a default option so checkout isn't blocked
    return res.json({
      shippingOptions: [{
        title: "Standard Shipping",
        rate: getShippingFlatRate(),
        transitDays: "3-5",
        description: "Standard delivery"
      }]
    });
  }
});

// Fetch full order details from Ecwid REST API
async function fetchEcwidOrder(orderId, storeId, accessToken) {
  if (!accessToken || !storeId) {
    return null;
  }
  const url = `https://app.ecwid.com/api/v3/${storeId}/orders/${orderId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      console.log(`[ecwid-api] fetch order ${orderId} failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.log(`[ecwid-api] fetch order ${orderId} error: ${err.message}`);
    return null;
  }
}

// Ecwid webhook: receives a NOTIFICATION (not the full order), then fetches
// the full order from the REST API and processes it.
app.post("/webhooks/ecwid/order-created", express.raw({ type: "*/*" }), async (req, res) => {
  // Respond immediately — Ecwid requires a fast 200 or it retries
  res.status(200).send("ok");

  // Verify HMAC signature when client secret is configured
  if (ECWID_CLIENT_SECRET) {
    const sig = req.headers["x-ecwid-signature-sha256"] || "";
    const expected = crypto
      .createHmac("sha256", ECWID_CLIENT_SECRET)
      .update(req.body)
      .digest("base64");
    if (sig !== expected) {
      console.log("[webhook] signature mismatch — ignored");
      return;
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    console.log("[webhook] invalid JSON body");
    return;
  }

  console.log(`[webhook] received event: ${JSON.stringify(event)}`);

  // Ecwid sends: { eventType, storeId, entityId, data: { orderId, newPaymentStatus, ... } }
  const orderId = event?.data?.orderId || event?.entityId || event?.orderNumber || event?.id;
  if (!orderId) {
    console.log("[webhook] no orderId found in event");
    return;
  }

  // Resolve store credentials from the webhook event's storeId
  const webhookStoreId = String(event?.storeId || "");
  const whCreds = resolveStoreCredentials(webhookStoreId);
  if (!whCreds.accessToken) {
    console.log(`[webhook] no credentials for store ${webhookStoreId} — cannot fetch order`);
    return;
  }

  console.log(`[webhook] fetching full order ${orderId} from Ecwid API (store ${whCreds.storeId})...`);
  const order = await fetchEcwidOrder(orderId, whCreds.storeId, whCreds.accessToken);
  if (!order) {
    console.log(`[webhook] could not fetch order ${orderId}`);
    return;
  }

  const result = await processEcwidOrder(order, { storeId: whCreds.storeId, accessToken: whCreds.accessToken });
  console.log(`[webhook] order #${orderId} — recorded ${result.recorded} registry purchase(s)`);
});

// ─── Manual sync: fetch recent orders from Ecwid and process any that contain
// registry items. Use this to backfill orders placed before the webhook was fixed.
app.post("/admin/sync-orders", async (req, res) => {
  const syncStoreId = req.ecwid.store_id;
  const syncCreds = resolveStoreCredentials(syncStoreId);
  if (!syncCreds.accessToken || !syncCreds.storeId) {
    return res.redirect("/admin?error=" + encodeURIComponent("Ecwid API credentials not configured."));
  }
  try {
    const url = `https://app.ecwid.com/api/v3/${syncCreds.storeId}/orders?limit=50&sortBy=DATE_CREATED&sortDirection=DESC`;
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${syncCreds.accessToken}` } });
    if (!apiRes.ok) {
      return res.redirect("/admin?error=" + encodeURIComponent(`Ecwid API error: ${apiRes.status}`));
    }
    const data = await apiRes.json();
    const orders = data?.items || [];
    let totalRecorded = 0;
    for (const order of orders) {
      const result = await processEcwidOrder(order, { storeId: syncCreds.storeId, accessToken: syncCreds.accessToken });
      totalRecorded += result.recorded;
    }
    const msg = `Synced ${orders.length} orders — recorded ${totalRecorded} new registry purchase(s).`;
    console.log(`[sync] ${msg}`);
    return res.redirect("/admin?info=" + encodeURIComponent(msg));
  } catch (err) {
    console.log(`[sync] error: ${err.message}`);
    return res.redirect("/admin?error=" + encodeURIComponent(`Sync failed: ${err.message}`));
  }
});

// ─── Auto-sync: poll Ecwid for recent orders every 2 minutes ─────────────────
// Iterates all registered stores (from the `stores` table + legacy env var fallback).
{
  const AUTO_SYNC_INTERVAL = 2 * 60 * 1000; // 2 minutes
  setInterval(async () => {
    // Build list of stores to sync
    const storesToSync = getAllStores().map(s => ({ storeId: s.store_id, accessToken: s.access_token }));
    // Add legacy env-var store if not already in DB
    if (LEGACY_ECWID_STORE_ID && LEGACY_ECWID_ACCESS_TOKEN) {
      if (!storesToSync.some(s => s.storeId === LEGACY_ECWID_STORE_ID)) {
        storesToSync.push({ storeId: LEGACY_ECWID_STORE_ID, accessToken: LEGACY_ECWID_ACCESS_TOKEN });
      }
    }
    if (storesToSync.length === 0) return;

    for (const store of storesToSync) {
      try {
        const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const url = `https://app.ecwid.com/api/v3/${store.storeId}/orders?createdFrom=${encodeURIComponent(since)}&limit=50&sortBy=DATE_CREATED&sortDirection=DESC`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${store.accessToken}` } });
        if (!res.ok) continue;
        const data = await res.json();
        const orders = data?.items || [];
        let recorded = 0;
        for (const order of orders) {
          const result = await processEcwidOrder(order, { storeId: store.storeId, accessToken: store.accessToken });
          recorded += result.recorded;
        }
        if (recorded > 0) console.log(`[auto-sync] store ${store.storeId}: recorded ${recorded} new registry purchase(s)`);
      } catch (err) {
        console.log(`[auto-sync] store ${store.storeId} error: ${err.message}`);
      }
    }
  }, AUTO_SYNC_INTERVAL);
  console.log("[auto-sync] enabled — polling every 2 minutes for all stores");
}

// ─── Lightweight storefront cart script ──────────────────────────────────────
// Per-item registry labeling for Ecwid cart pages.
// Reads _reg_items from localStorage (written by registry.js when items are added).
// Shows a Registry Summary Panel above the cart and passes registry data to checkout.
// ── Global cart guard ──────────────────────────────────────────────────────
// Tiny script the registry section injects once into the page. Persists
// across SPA navigation so the guard runs even when the user is on a
// regular product page, not the registry page.
app.get("/widget/cart-guard.js", (req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.send(`
(function(){
  if (window.__regCartGuardInstalled) return;
  window.__regCartGuardInstalled = true;

  function showGuardToast() {
    var existing = document.getElementById('reg-guard-toast');
    if (existing) { clearTimeout(existing._timer); existing.parentNode && existing.parentNode.removeChild(existing); }
    var toast = document.createElement('div');
    toast.id = 'reg-guard-toast';
    toast.setAttribute('style', [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      'background:#1a1a1a', 'color:#fff', 'padding:14px 20px 14px 16px',
      'border-radius:8px', 'font-family:inherit', 'font-size:14px',
      'z-index:2147483647', 'box-shadow:0 4px 20px rgba(0,0,0,0.35)',
      'max-width:420px', 'width:calc(100% - 48px)', 'text-align:center',
      'display:flex', 'align-items:flex-start', 'gap:12px'
    ].join(';'));
    var msg = document.createElement('span');
    msg.style.flex = '1';
    msg.textContent = 'Regular items cannot be added while registry items are in your cart. Visit the registry page to clear your cart first.';
    var close = document.createElement('button');
    close.setAttribute('style', 'background:none;border:none;color:#aaa;cursor:pointer;font-size:18px;line-height:1;padding:0;flex-shrink:0;');
    close.textContent = '\\u00d7';
    close.onclick = function(){ toast.parentNode && toast.parentNode.removeChild(toast); };
    toast.appendChild(msg);
    toast.appendChild(close);
    document.body.appendChild(toast);
    toast._timer = setTimeout(function(){ toast.parentNode && toast.parentNode.removeChild(toast); }, 6000);
  }

  var _guardPollTimer = null;

  function checkCart() {
    var regItems = {};
    try { regItems = JSON.parse(localStorage.getItem('_reg_items') || '{}'); } catch(e) {}
    if (Object.keys(regItems).length === 0) {
      if (_guardPollTimer) { clearInterval(_guardPollTimer); _guardPollTimer = null; }
      return;
    }
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') return;
    Ecwid.Cart.get(function(cart) {
      var items = (cart && (cart.items || cart.products)) || [];
      try {
        var pids = [];
        for (var i = 0; i < items.length; i++) {
          var p = (items[i] && items[i].product) || items[i];
          var id = String((p && p.id) || items[i].productId || 0);
          if (id !== '0') pids.push(id);
        }
        localStorage.setItem('_cart_pids', JSON.stringify(pids));
      } catch(e) {}
      var ri = {};
      try { ri = JSON.parse(localStorage.getItem('_reg_items') || '{}'); } catch(e) {}
      if (Object.keys(ri).length === 0) return;
      var hadConflict = false;
      for (var j = items.length - 1; j >= 0; j--) {
        var product = (items[j] && items[j].product) || items[j];
        var pid = String((product && product.id) || items[j].productId || 0);
        if (pid === '0') continue;
        var tracked = ri[pid];
        if (!tracked || (Array.isArray(tracked) && tracked.length === 0)) {
          Ecwid.Cart.removeProduct(j);
          hadConflict = true;
        }
      }
      if (hadConflict) showGuardToast();
    });
  }

  function onCartChanged(cart) {
    try {
      var items = (cart && (cart.items || cart.products)) || [];
      var pids = [];
      for (var i = 0; i < items.length; i++) {
        var p = (items[i] && items[i].product) || items[i];
        var id = String((p && p.id) || items[i].productId || 0);
        if (id !== '0') pids.push(id);
      }
      localStorage.setItem('_cart_pids', JSON.stringify(pids));
    } catch(e) {}
    setTimeout(checkCart, 150);
  }

  function subscribe() {
    if (!window.Ecwid || !Ecwid.OnCartChanged || !Ecwid.OnCartChanged.add) return false;
    Ecwid.OnCartChanged.add(onCartChanged);
    if (Ecwid.OnPageLoaded && Ecwid.OnPageLoaded.add) {
      Ecwid.OnPageLoaded.add(function(){ setTimeout(checkCart, 400); });
    }
    if (!_guardPollTimer) _guardPollTimer = setInterval(checkCart, 3000);
    setTimeout(checkCart, 500);
    return true;
  }
  if (!subscribe()) {
    var _poll = setInterval(function(){ if (subscribe()) clearInterval(_poll); }, 500);
  }
})();
`);
});

// Usage: <script src="https://your-app/widget/cart.js"></script>
app.get("/widget/cart.js", (req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.send(`
(function(){
  console.log('[registry-cart] v8 loaded');

  // ── HTML escaper ──
  function esc(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s || ''));
    return d.innerHTML;
  }

  // ── Find the Ecwid store container ──
  function findStoreEl() {
    return document.getElementById('ecwid-store') ||
      document.querySelector('[id^="my-store-"]') ||
      document.querySelector('.ecwid');
  }

  // ── Read per-item registry map from localStorage ──
  // New format: { "productId": [{ rid, name, qty }] }
  // Old format: { "productId": { rid, name } } — auto-normalized
  function getRegItems() {
    try {
      var raw = JSON.parse(localStorage.getItem('_reg_items') || '{}');
      // Normalize: convert old single-object format to array format
      var normalized = {};
      Object.keys(raw).forEach(function(pid) {
        var val = raw[pid];
        if (Array.isArray(val)) {
          normalized[pid] = val;
        } else if (val && typeof val === 'object') {
          normalized[pid] = [{ rid: val.rid, name: val.name, qty: val.qty || 1 }];
        }
      });
      return normalized;
    } catch(e) { return {}; }
  }

  // ── Build grouped registry data from cart + localStorage ──
  function buildRegistryGroups(regItems, cartItems) {
    // Map product ID → cart item info (name, cart qty, cart index)
    var cartMap = {};
    cartItems.forEach(function(it, idx) {
      var product = (it && it.product) || it;
      var pid = String((product && product.id) || it.productId || 0);
      var name = (product && product.name) || it.name || '';
      var qty = Number(it.quantity || (product && product.quantity) || 1);
      if (pid !== '0') cartMap[pid] = { name: name, cartQty: qty, cartIndex: idx };
    });

    // Group by registry: { registryName: [{ pid, rid, name, regQty, cartQty, cartIndex }] }
    var groups = {};
    Object.keys(regItems).forEach(function(pid) {
      if (!cartMap[pid]) return; // not in cart, skip
      var entries = regItems[pid];
      entries.forEach(function(entry) {
        var regName = entry.name || 'Gift Registry';
        if (!groups[regName]) groups[regName] = [];
        var regQty = Math.min(entry.qty || 1, cartMap[pid].cartQty);
        groups[regName].push({
          pid: pid,
          rid: entry.rid,
          name: cartMap[pid].name,
          regQty: regQty,
          cartQty: cartMap[pid].cartQty,
          cartIndex: cartMap[pid].cartIndex
        });
      });
    });
    return groups;
  }

  // ── Remove a registry item: decrement localStorage + decrease cart qty ──
  function removeRegItem(pid, rid) {
    // 1. Decrement qty in _reg_items localStorage
    try {
      var raw = JSON.parse(localStorage.getItem('_reg_items') || '{}');
      var entries = raw[pid];
      if (entries && !Array.isArray(entries)) {
        entries = [{ rid: entries.rid, name: entries.name, qty: entries.qty || 1 }];
      }
      if (!Array.isArray(entries)) return;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].rid === rid) {
          entries[i].qty = (entries[i].qty || 1) - 1;
          if (entries[i].qty <= 0) entries.splice(i, 1);
          break;
        }
      }
      if (entries.length === 0) {
        delete raw[pid];
      } else {
        raw[pid] = entries;
      }
      localStorage.setItem('_reg_items', JSON.stringify(raw));
    } catch(e) {}

    // 2. Decrease qty in Ecwid cart
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') {
      showRegistrySummary();
      return;
    }
    Ecwid.Cart.get(function(cart) {
      var items = (cart && cart.items) || [];
      for (var j = 0; j < items.length; j++) {
        var product = (items[j] && items[j].product) || items[j];
        var itemPid = String((product && product.id) || items[j].productId || 0);
        if (itemPid === String(pid)) {
          var currentQty = Number(items[j].quantity || 1);
          if (currentQty <= 1) {
            // Remove entirely
            Ecwid.Cart.removeProduct(j);
          } else {
            // Remove then re-add with qty-1 (no setQuantity API available)
            Ecwid.Cart.removeProduct(j);
            setTimeout(function() {
              Ecwid.Cart.addProduct(Number(pid), currentQty - 1);
            }, 300);
          }
          break;
        }
      }
      // Refresh panel immediately
      setTimeout(function() { showRegistrySummary(); }, 500);
    });
  }

  // ── Registry Summary Panel ──
  var _panelId = '_reg-summary';
  var _panelBound = false;

  function showRegistrySummary() {
    var regItems = getRegItems();
    if (!Object.keys(regItems).length) {
      removePanel();
      return;
    }
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') return;

    Ecwid.Cart.get(function(cart) {
      var cartItems = (cart && cart.items) || [];
      if (!Array.isArray(cartItems) || !cartItems.length) {
        removePanel();
        return;
      }

      var groups = buildRegistryGroups(regItems, cartItems);
      var registryNames = Object.keys(groups);
      if (!registryNames.length) {
        removePanel();
        return;
      }

      // Build panel HTML
      var html = '<div style="font-family:sans-serif;font-size:15px;font-weight:600;margin-bottom:10px;">\\uD83C\\uDF81 Gift Registry Purchases</div>';
      registryNames.forEach(function(regName) {
        html += '<div style="margin-bottom:8px;">';
        html += '<div style="font-weight:600;font-size:14px;color:#333;margin-bottom:4px;">' + esc(regName) + '</div>';
        html += '<ul style="margin:0 0 0 8px;padding:0;list-style:none;">';
        groups[regName].forEach(function(item) {
          html += '<li style="padding:3px 0;font-size:13px;color:#444;">';
          html += '\\u2022 ' + esc(item.name);
          html += ' <span style="color:#666;">\\u00D7' + item.regQty + '</span>';
          if (item.cartQty > item.regQty) {
            html += ' <span style="font-size:11px;color:#888;">(' + item.regQty + ' of ' + item.cartQty + ' in cart)</span>';
          }
          html += ' <button data-reg-remove-pid="' + item.pid + '" data-reg-remove-rid="' + item.rid + '" '
            + 'style="background:none;border:1px solid #ccc;border-radius:3px;padding:0px 5px;cursor:pointer;font-size:11px;color:#999;line-height:1.3;vertical-align:middle;" '
            + 'title="Remove from registry purchase">\\u00D7</button>';
          html += '</li>';
        });
        html += '</ul></div>';
      });
      html += '<div style="font-size:12px;color:#666;margin-top:6px;border-top:1px solid #d8e8d8;padding-top:6px;">These items will be recorded as purchased on their registries upon checkout.</div>';

      var existing = document.getElementById(_panelId);
      if (existing) {
        existing.innerHTML = html;
      } else {
        var box = document.createElement('div');
        box.id = _panelId;
        box.style.cssText = 'background:#f0f7f0;border:1px solid #b8d8b8;border-radius:6px;padding:14px 18px;margin:0 0 16px;';
        box.innerHTML = html;
        var storeEl = findStoreEl();
        if (storeEl && storeEl.parentNode) {
          storeEl.parentNode.insertBefore(box, storeEl);
        }
      }

      // Bind click delegation once on the panel
      var panel = document.getElementById(_panelId);
      if (panel && !_panelBound) {
        _panelBound = true;
        panel.addEventListener('click', function(e) {
          var btn = e.target.closest('[data-reg-remove-pid]');
          if (!btn) return;
          var removePid = btn.getAttribute('data-reg-remove-pid');
          var removeRid = Number(btn.getAttribute('data-reg-remove-rid'));
          if (removePid && removeRid) removeRegItem(removePid, removeRid);
        });
      }
    });
  }

  function removePanel() {
    var el = document.getElementById(_panelId);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    _panelBound = false;
  }

  // ── Pass registry data to checkout via ec.order.extraFields ──
  function setRegistryExtraFields() {
    var regItems = getRegItems();
    if (!Object.keys(regItems).length) return;
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') return;

    Ecwid.Cart.get(function(cart) {
      var cartItems = (cart && cart.items) || [];
      // Build compact data: { "productId": [{ rid, qty }] }
      var data = {};
      var cartMap = {};
      cartItems.forEach(function(it) {
        var product = (it && it.product) || it;
        var pid = String((product && product.id) || it.productId || 0);
        var qty = Number(it.quantity || (product && product.quantity) || 1);
        if (pid !== '0') cartMap[pid] = qty;
      });

      Object.keys(regItems).forEach(function(pid) {
        if (!cartMap[pid]) return;
        var entries = regItems[pid];
        data[pid] = entries.map(function(e) {
          return { rid: e.rid, qty: Math.min(e.qty || 1, cartMap[pid]) };
        });
      });

      if (!Object.keys(data).length) return;

      window.ec = window.ec || {};
      ec.order = ec.order || {};
      ec.order.extraFields = ec.order.extraFields || {};
      ec.order.extraFields.registry_data = {
        title: '',
        value: JSON.stringify(data),
        type: 'text',
        orderDetailsDisplaySection: 'hidden'
      };
    });
  }

  // ── Run summary + extraFields on every tick ──
  setInterval(function() {
    showRegistrySummary();
    setRegistryExtraFields();
  }, 2000);

  setTimeout(function() {
    showRegistrySummary();
    setRegistryExtraFields();
  }, 1000);
})();
`);
});

// Storefront widget JS
app.get("/widget/registry.js", (req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.send(`
(function(){
  console.log('[registry-widget] v6 loaded');
  const baseUrl = "${BASE_URL}";
  const defaultStoreId = "${LEGACY_ECWID_STORE_ID}";

  // Inject fallback fonts only when the page doesn't already have custom fonts
  // loaded (i.e. when running on our own standalone /registry page, not when
  // embedded inside a merchant's Ecwid storefront which has its own fonts).
  if (!document.querySelector('link[data-registry-fonts]')) {
    var hasStorefrontFonts = document.querySelector(
      'link[href*="fonts.googleapis"], link[href*="fonts.gstatic"], link[href*="typekit"],' +
      'link[href*="use.typekit"], link[href*="cloud.typography"], style[data-font]'
    );
    if (!hasStorefrontFonts) {
      const link = document.createElement('link');
      link.setAttribute('data-registry-fonts', '1');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=Prata&display=swap';
      document.head.appendChild(link);
    }
  }

  // Inject widget styles if not already present
  if (!document.querySelector('link[data-registry-styles]')) {
    const link = document.createElement('link');
    link.setAttribute('data-registry-styles', '1');
    link.rel = 'stylesheet';
    link.href = baseUrl + '/public/styles.css';
    document.head.appendChild(link);
  }

  function findContainer(){
    return document.getElementById('registry-app') || document.querySelector('[data-registry-app="1"]');
  }

  function fmtDate(dateStr){
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return isNaN(d) ? dateStr : d.toLocaleDateString();
  }

  function esc(str){
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ── Cart PID cache (maintained via OnCartChanged) ───────────────────────
  // Keeps _cart_pids in localStorage up to date so detectCartConflict can
  // check for regular shopping items without calling Cart.get at click time.
  (function subscribeCartCache() {
    // Combined handler: guards against mixing regular + registry items, and
    // keeps _cart_pids fresh for detectCartConflict.
    // Keeps _cart_pids fresh for detectCartConflict. Guard logic (ejecting
    // regular items) is handled by the globally-injected cart-guard.js.
    function _onCartChanged(cart) {
      try {
        var items = (cart && (cart.items || cart.products)) || [];
        var pids = [];
        for (var i = 0; i < items.length; i++) {
          var product = (items[i] && items[i].product) || items[i];
          var pid = String((product && product.id) || items[i].productId || 0);
          if (pid !== '0') pids.push(pid);
        }
        localStorage.setItem('_cart_pids', JSON.stringify(pids));
      } catch(e) {}
    }
    function _subscribe() {
      if (window.Ecwid && Ecwid.OnCartChanged && Ecwid.OnCartChanged.add) {
        Ecwid.OnCartChanged.add(_onCartChanged);
        if (typeof Ecwid.Cart.get === 'function') Ecwid.Cart.get(_onCartChanged);
        return true;
      }
      return false;
    }
    if (!_subscribe()) {
      var _poll = setInterval(function() { if (_subscribe()) clearInterval(_poll); }, 500);
    }
  })();

  function hasCartApi(){
    return !!(window.Ecwid && Ecwid.Cart && typeof Ecwid.Cart.addProduct === 'function');
  }

  function ensureEcwidScript(effectiveStoreId){
    return new Promise((resolve, reject) => {
      if (hasCartApi()) return resolve();
      if (!effectiveStoreId) return reject(new Error('Missing store ID'));
      const existing = document.querySelector('script[data-registry-ecwid="1"]');
      if (existing) return resolve();
      const script = document.createElement('script');
      script.setAttribute('data-registry-ecwid', '1');
      script.src = 'https://app.ecwid.com/script.js?' + encodeURIComponent(String(effectiveStoreId)) + '&data_platform=code&data_date=' + Date.now();
      script.async = true;
      script.onload = function(){ resolve(); };
      script.onerror = function(){ reject(new Error('Failed to load Ecwid script')); };
      document.head.appendChild(script);
    });
  }

  function ensureCartApi(effectiveStoreId){
    if (hasCartApi()) return Promise.resolve();
    return ensureEcwidScript(effectiveStoreId).then(() => {
      return new Promise((resolve, reject) => {
        let tries = 0;
        const maxTries = 20;
        const timer = setInterval(() => {
          if (hasCartApi()) {
            clearInterval(timer);
            resolve();
            return;
          }
          tries += 1;
          if (tries >= maxTries) {
            clearInterval(timer);
            reject(new Error('Ecwid cart API unavailable'));
          }
        }, 250);
      });
    });
  }

  // ── Per-item registry tracking ──
  // When an item is added to cart from a registry page, store the mapping
  // in localStorage so cart.js can show the registry summary panel.
  // Format: { "productId": [{ rid: number, name: "Registry Name", qty: number }] }
  function trackRegItem(productId, registry) {
    try {
      var regItems = JSON.parse(localStorage.getItem('_reg_items') || '{}');
      var pid = String(productId);
      var entries = regItems[pid];
      // Normalize old format (single object → array)
      if (entries && !Array.isArray(entries)) {
        entries = [{ rid: entries.rid, name: entries.name, qty: 1 }];
      }
      if (!Array.isArray(entries)) entries = [];
      // Find existing entry for this registry
      var found = false;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].rid === registry.id) {
          entries[i].qty = (entries[i].qty || 1) + 1;
          found = true;
          break;
        }
      }
      if (!found) {
        entries.push({ rid: registry.id, name: registry.display_name, qty: 1 });
      }
      regItems[pid] = entries;
      localStorage.setItem('_reg_items', JSON.stringify(regItems));
    } catch(e) {}
  }

  function untrackRegItem(productId, registryId) {
    try {
      var regItems = JSON.parse(localStorage.getItem('_reg_items') || '{}');
      var pid = String(productId);
      var entries = Array.isArray(regItems[pid]) ? regItems[pid] : [];
      var filtered = entries.filter(function(e) { return e.rid !== registryId; });
      if (filtered.length === 0) { delete regItems[pid]; } else { regItems[pid] = filtered; }
      localStorage.setItem('_reg_items', JSON.stringify(regItems));
    } catch(e) {}
  }

  // ── Cart conflict detection ──────────────────────────────────────────────
  // Detects if adding a registry item would mix it with items from a different
  // registry or with regular (non-registry) shopping items.
  // Step 1 checks _reg_items in localStorage (synchronous, always works).
  // Step 2 checks Cart.get for regular shopping items (async, best-effort).
  function detectCartConflict(newRegistryId, callback) {
    // Step 1: Check _reg_items for different-registry conflict (no Cart.get needed)
    var regItems = {};
    try { regItems = JSON.parse(localStorage.getItem('_reg_items') || '{}'); } catch(e) {}

    var existingRegName = '';
    var hasDifferentRegistry = false;
    var pids = Object.keys(regItems);
    for (var p = 0; p < pids.length; p++) {
      var entries = regItems[pids[p]];
      if (!Array.isArray(entries)) continue;
      for (var k = 0; k < entries.length; k++) {
        if (entries[k].rid !== newRegistryId) {
          hasDifferentRegistry = true;
          existingRegName = entries[k].name || 'another registry';
          break;
        }
      }
      if (hasDifferentRegistry) break;
    }

    if (hasDifferentRegistry) {
      callback({ type: 'registry', message: 'Your cart has items from "' + existingRegName + '".' });
      return;
    }

    // Step 2: Check _cart_pids cache for regular (non-registry) items (synchronous)
    var cachedPids = [];
    try { cachedPids = JSON.parse(localStorage.getItem('_cart_pids') || '[]'); } catch(e) {}
    for (var c = 0; c < cachedPids.length; c++) {
      var cpid = cachedPids[c];
      if (cpid === '0') continue;
      var ctracked = regItems[cpid];
      if (!ctracked || (Array.isArray(ctracked) && ctracked.length === 0)) {
        callback({ type: 'regular', message: 'Your cart contains items from regular shopping.' });
        return;
      }
    }
    callback(null);
  }

  // ── Clear cart and then run a callback ──────────────────────────────────
  function clearCartAndProceed(proceed) {
    localStorage.removeItem('_reg_items');
    localStorage.removeItem('_cart_pids');
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') {
      proceed(); return;
    }
    Ecwid.Cart.get(function(cart) {
      var items = (cart && cart.items) || [];
      // Remove in reverse index order to avoid index shifting
      for (var i = items.length - 1; i >= 0; i--) {
        Ecwid.Cart.removeProduct(i);
      }
      setTimeout(proceed, 400);
    });
  }

  // ── Show cart conflict warning modal ────────────────────────────────────
  function showConflictModal(message, onClear, onKeep) {
    var modalId = '_reg-conflict-modal';
    var existing = document.getElementById(modalId);
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:#fff;border-radius:8px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 4px 24px rgba(0,0,0,0.18);">'
      + '<div style="font-size:18px;font-weight:700;margin-bottom:12px;">&#9888; Cart Conflict</div>'
      + '<div style="font-size:14px;color:#444;margin-bottom:20px;">' + esc(message) + ' Would you like to clear your cart and add this item, or keep your current cart?</div>'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;">'
      + '<button id="_reg-conflict-keep" style="padding:8px 16px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:14px;">Keep Current Items</button>'
      + '<button id="_reg-conflict-clear" style="padding:8px 16px;border:none;border-radius:4px;background:#e53e3e;color:#fff;cursor:pointer;font-size:14px;">Clear Cart &amp; Add</button>'
      + '</div></div>';
    document.body.appendChild(overlay);

    document.getElementById('_reg-conflict-keep').addEventListener('click', function() {
      overlay.parentNode.removeChild(overlay);
      onKeep();
    });
    document.getElementById('_reg-conflict-clear').addEventListener('click', function() {
      overlay.parentNode.removeChild(overlay);
      onClear();
    });
  }

  // ── Registry portal inline in Ecwid account section ───────────────────────
  // When a logged-in customer visits their Ecwid account section, silently
  // authenticate them with our server and embed the registry portal as an
  // inline iframe — no separate page required.
  (function(){
    var _plId = 'registry-portal-inline-wrap';
    var _acctPages = ['ACCOUNT_SETTINGS','MY_ORDERS','ADDRESS_BOOK','FAVORITES','RESET_PASSWORD'];

    function _removePL(){
      var el = document.getElementById(_plId);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function _injectPortal(email){
      if (document.getElementById(_plId)) return;

      // Silently authenticate with our server; this sets the portal session cookie
      fetch(baseUrl + '/portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email })
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (!data.ok) return; // no registry linked for this customer — stay silent

        var wrap = document.createElement('div');
        wrap.id = _plId;
        wrap.style.cssText = 'margin-bottom:24px;';

        var iframe = document.createElement('iframe');
        iframe.id = 'registry-portal-frame';
        iframe.src = baseUrl + '/portal';
        iframe.style.cssText = 'width:100%;border:none;display:block;overflow:hidden;min-height:400px;';
        iframe.scrolling = 'no';
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allowtransparency', 'true');

        // Auto-resize the iframe to fit its content via postMessage from /portal
        window.addEventListener('message', function(evt){
          if (evt.data && evt.data.type === 'registry-portal-height') {
            iframe.style.height = (Number(evt.data.height) + 40) + 'px';
          }
        });

        wrap.appendChild(iframe);

        // Insert the portal before the Ecwid store container
        var storeEl = document.querySelector('[id^="my-store-"]');
        if (storeEl && storeEl.parentNode) {
          storeEl.parentNode.insertBefore(wrap, storeEl);
        } else {
          document.body.insertAdjacentElement('afterbegin', wrap);
        }
      })
      .catch(function(){});
    }

    function _onPage(page){
      _removePL();
      if (!(page && _acctPages.indexOf(page.type) !== -1)) return;
      if (!window.Ecwid || !Ecwid.Customer) return;
      Ecwid.Customer.get(function(customer){
        if (customer && customer.email) _injectPortal(customer.email);
      });
    }

    function _hookPL(){
      if (window.Ecwid && Ecwid.OnPageLoad) Ecwid.OnPageLoad.add(_onPage);
    }

    if (window.Ecwid && Ecwid.OnAPILoaded) {
      Ecwid.OnAPILoaded.add(_hookPL);
    } else {
      var _plWait = setInterval(function(){
        if (window.Ecwid && Ecwid.OnAPILoaded){
          clearInterval(_plWait);
          Ecwid.OnAPILoaded.add(_hookPL);
        }
      }, 300);
    }
  })();

  // ── Storefront theme detection ───────────────────────────────────────────
  // Reads the host page's computed styles and applies them as CSS custom
  // properties on the widget container, so the registry widget blends into
  // whichever Ecwid storefront theme the merchant is using.
  function detectTheme(container) {
    try {
      var bodyStyle = getComputedStyle(document.body);

      // Body font & text color
      var fontFamily = bodyStyle.fontFamily || 'sans-serif';
      var textColor  = bodyStyle.color || '#212427';

      // Heading font — prefer h1/h2, fall back to body font
      var headingEl  = document.querySelector('h1:not([class*="reg"]), h2:not([class*="reg"])');
      var headingFont = headingEl
        ? getComputedStyle(headingEl).fontFamily || fontFamily
        : fontFamily;

      // Primary action color — try Ecwid's native buy/CTA buttons first
      var btnSelectors = [
        '.gwt-Button.btn-buy',
        '.ec-btn.ec-btn--primary',
        '[class*="ecwid"] .gwt-Button',
        'button[data-hook="button-buy-now"]',
        '.btn-primary', 'button.primary', '[class*="primary-button"]'
      ];
      var btnEl = null;
      for (var si = 0; si < btnSelectors.length; si++) {
        btnEl = document.querySelector(btnSelectors[si]);
        if (btnEl) break;
      }

      // Fall back to first non-widget link for accent color
      var linkEl = document.querySelector('a:not([class*="reg-"]):not([class*="registry"])');

      var accentColor   = null;
      var accentBgColor = null;
      var btnTextColor  = '#ffffff';

      if (btnEl) {
        var bs = getComputedStyle(btnEl);
        var bg = bs.backgroundColor;
        // Ignore transparent/unset backgrounds
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          accentBgColor = bg;
          btnTextColor  = bs.color || '#ffffff';
        }
        accentColor = accentBgColor || bs.color || null;
      }
      if (!accentColor && linkEl) {
        accentColor = getComputedStyle(linkEl).color || null;
      }

      // Border color — derive a subtle border from the text color
      var borderColor = 'rgba(0,0,0,0.12)';
      var mutedColor  = textColor; // will be made translucent via opacity below

      // Apply as CSS custom properties on the container element.
      // Inline style properties override the stylesheet .registry-root defaults.
      container.style.setProperty('--reg-font',         fontFamily);
      container.style.setProperty('--reg-heading-font', headingFont);
      container.style.setProperty('--reg-ink',          textColor);
      container.style.setProperty('--reg-muted',        'color-mix(in srgb, ' + textColor + ' 55%, transparent)');
      container.style.setProperty('--reg-border',       borderColor);
      container.style.setProperty('--reg-white',        '#ffffff');
      container.style.setProperty('--reg-card',         'rgba(0,0,0,0.03)');
      if (accentColor)   container.style.setProperty('--reg-accent',       accentColor);
      if (accentBgColor) container.style.setProperty('--reg-accent-light', accentBgColor);
      container.style.setProperty('--reg-btn-text',     btnTextColor);

      // Detect if the site uses squared or rounded corners from buttons/inputs
      var firstBtn = btnEl || document.querySelector('button, input[type="submit"]');
      if (firstBtn) {
        var radius = getComputedStyle(firstBtn).borderRadius;
        if (radius && radius !== '0px') {
          container.style.setProperty('--reg-radius', radius);
        }
      }
    } catch(e) {
      // Leave CSS variable defaults in place if detection fails
    }
  }

  function mount(container){
    if (container.getAttribute('data-registry-mounted') === '1') return;
    container.setAttribute('data-registry-mounted', '1');
    container.classList.add('registry-root');
    // Apply storefront theme to widget before first render
    detectTheme(container);

    const isEmbed = container.getAttribute('data-embed') === 'true';
    const inIframe = window.self !== window.top;
    const storeId = container.getAttribute('data-store-id') || '';
    // Support deep-link: ?reg=ID in the page URL auto-opens that registry
    const _urlReg = new URLSearchParams(window.location.search).get('reg') || '';
    let activeRegistryId = _urlReg || container.getAttribute('data-registry-id') || '';

    let searchTimer = null;

    function renderList(data, searchValue){
      const effectiveStoreId = storeId || defaultStoreId || '';
      const detailSuffix = effectiveStoreId ? ('?store_id=' + encodeURIComponent(String(effectiveStoreId))) : '';
      const detailBase = baseUrl + '/registry/';

      const searchBox =
        '<div class="reg-search-wrap">' +
          '<input class="reg-search" type="text" placeholder="Search by name&hellip;" value="' + esc(searchValue || '') + '" />' +
        '</div>';

      if (!Array.isArray(data) || data.length === 0) {
        container.innerHTML =
          '<div class="reg-header">Gift Registries</div>' +
          searchBox +
          '<div class="reg-sub">No registries found.</div>';
        bindSearch();
        return;
      }
      const cards = data.map(r => {
        if (isEmbed) {
          return (
            '<div class="reg-card">' +
              '<div class="reg-name">' + esc(r.display_name) + '</div>' +
              '<div class="reg-meta">' + esc(fmtDate(r.event_date)) + ' · ' + r.item_count + ' items</div>' +
              '<div class="reg-actions"><button class="reg-btn reg-open-btn" data-open-id="' + r.id + '">View Registry</button></div>' +
            '</div>'
          );
        }
        return (
          '<a class="reg-card" href="' + detailBase + r.id + detailSuffix + '">' +
            '<div class="reg-name">' + esc(r.display_name) + '</div>' +
            '<div class="reg-meta">' + esc(fmtDate(r.event_date)) + ' · ' + r.item_count + ' items</div>' +
          '</a>'
        );
      }).join('');

      container.innerHTML =
        '<div class="reg-header">Gift Registries</div>' +
        searchBox +
        '<div class="reg-list">' + cards + '</div>';

      bindSearch();

      if (isEmbed) {
        container.querySelectorAll('.reg-open-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            activeRegistryId = btn.getAttribute('data-open-id') || '';
            loadData();
          });
        });
      }
    }

    function bindSearch(){
      const input = container.querySelector('.reg-search');
      if (!input) return;
      input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          loadData(input.value.trim());
        }, 350);
      });
      input.focus();
    }

    function renderDetail(payload){
      const registry = payload.registry;
      const items = payload.items || [];
      const effectiveStoreId = storeId || registry.store_id || defaultStoreId || '';

      function setStatus(message, isError){
        const node = container.querySelector('.reg-status');
        if (!node) return;
        node.className = isError ? 'reg-status reg-error' : 'reg-status reg-ok';
        if (isError) {
          node.textContent = message || '';
        } else {
          node.innerHTML = message || '';
        }
      }
      const rows = items.map(item => {
        const stillNeeded = Number(item.still_needed ?? Math.max(0, (item.desired_qty || 0) - (item.purchased_qty || 0)));
        const action = '<button class="reg-btn" data-product-id="' + item.product_id + '">Add to cart</button>';
        const thumbHtml = item.product_thumbnail
          ? '<img class="reg-item-thumb" src="' + esc(item.product_thumbnail) + '" alt="" />'
          : '';
        return (
          '<div class="reg-item">' +
            thumbHtml +
            '<div>' +
              '<div class="reg-item-name">' + esc(item.product_name || 'Registry item') + '</div>' +
              '<div class="reg-item-meta">Desired: ' + item.desired_qty +
                ' · Purchased: ' + item.purchased_qty +
                ' · Still Needed: ' + stillNeeded + '</div>' +
            '</div>' +
            action +
          '</div>'
        );
      }).join('');

      const back = isEmbed ? '<button class="reg-back-btn">Back to Registries</button>' : '';
      const infoCard = (registry.photo || registry.description)
        ? '<div class="reg-info-card">' +
            (registry.photo
              ? '<img class="reg-info-photo" src="' + esc(registry.photo) + '" alt="Registry photo" />'
              : '') +
            (registry.description
              ? '<p class="reg-info-desc">' + esc(registry.description) + '</p>'
              : '') +
          '</div>'
        : '';
      container.innerHTML =
        '<div class="reg-header">' + esc(registry.display_name) + '</div>' +
        '<div class="reg-sub">' + esc(fmtDate(registry.event_date)) + '</div>' +
        infoCard +
        '<div class="reg-status"></div>' +
        back +
        '<div class="reg-items">' + rows + '</div>';

      const backBtn = container.querySelector('.reg-back-btn');
      if (backBtn) {
        backBtn.addEventListener('click', () => {
          activeRegistryId = '';
          loadData();
        });
      }

      if (inIframe) {
        setStatus('This page is in an iframe. Ecwid cart will not sync to the main storefront cart. Use script embed instead of iframe.', true);
      }

      container.querySelectorAll('.reg-btn[data-product-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const productId = Number(btn.getAttribute('data-product-id') || 0);
          if (!productId) {
            setStatus('This item cannot be added right now.', true);
            return;
          }
          if (inIframe) {
            setStatus('Cannot add to shared cart from iframe mode. Use HTML script embed on Instant Site page.', true);
            return;
          }
          const originalText = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Adding...';

          // Load Ecwid cart API first, THEN check for conflicts so Cart.get works reliably
          ensureCartApi(effectiveStoreId)
            .then(function(){
              detectCartConflict(registry.id, function(conflict) {
                if (conflict) {
                  btn.disabled = false;
                  btn.textContent = originalText;
                  showConflictModal(conflict.message, function() {
                    clearCartAndProceed(function() { performAdd(); });
                  }, function() {
                    // Keep current items — do nothing
                  });
                } else {
                  performAdd();
                }
              });

              function performAdd() {
                let settled = false;
                // Track optimistically so the global OnCartChanged guard does not
                // misidentify this registry item as a regular item while the
                // addProduct callback is still in flight.
                trackRegItem(productId, registry);

                function finish(ok, message){
                  if (settled) return;
                  settled = true;
                  // Remove cart-change listener
                  try { if (window.Ecwid && Ecwid.OnCartChanged) Ecwid.OnCartChanged.remove(_onCartChanged); } catch(e){}
                  if (ok) {
                    setStatus(message || 'Added to cart.', false);
                  } else {
                    untrackRegItem(productId, registry.id);
                    setStatus(message || 'Failed to add to cart.', true);
                  }
                  btn.disabled = false;
                  btn.textContent = originalText;
                }

                // Listen for Ecwid cart change as backup detection
                function _onCartChanged(cart) {
                  if (settled) return;
                  var items = (cart && (cart.items || cart.products)) || [];
                  var found = Array.isArray(items) && items.some(function(it) {
                    var pid = Number(
                      (it && (it.productId || (it.product && it.product.id) || it.id)) || 0
                    );
                    return pid === Number(productId);
                  });
                  if (found) finish(true, 'Added to cart.');
                }
                try { if (window.Ecwid && Ecwid.OnCartChanged) Ecwid.OnCartChanged.add(_onCartChanged); } catch(e){}

                // Fire addProduct — use the modern object form so the callback
                // is reliably invoked; also handle if it returns a Promise.
                console.log('[registry] adding product', productId);
                try {
                  const addResult = Ecwid.Cart.addProduct(
                    { id: productId, quantity: 1 },
                    function(success){
                      console.log('[registry] addProduct callback:', success);
                      finish(success !== false, success !== false ? 'Added to cart.' : 'Ecwid rejected this item.');
                    }
                  );
                  // Newer Ecwid versions return a Promise — handle it too
                  if (addResult && typeof addResult.then === 'function') {
                    addResult.then(function(){
                      finish(true, 'Added to cart.');
                    }).catch(function(){
                      finish(false, 'Failed to add to cart.');
                    });
                  }
                } catch (err) {
                  console.log('[registry] addProduct error:', err);
                  untrackRegItem(productId, registry.id);
                  finish(false, 'Failed to add to cart.');
                }

                // Fallback: assume success after 2s (item was likely added)
                setTimeout(function(){
                  if (!settled) {
                    console.log('[registry] callback never fired, assuming success');
                    finish(true, 'Added to cart.');
                  }
                }, 2000);
              }
            })
            .catch(function(err){
              console.log('[registry] ensureCartApi failed:', err);
              setStatus('Cart API unavailable. Try adding from the store product page.', true);
              btn.disabled = false;
              btn.textContent = originalText;
            });
        });
      });
    }

    function loadData(searchQuery){
      const effectiveStoreId = storeId || defaultStoreId || '';
      if (activeRegistryId) {
        container.innerHTML = '<div class="reg-sub">Loading...</div>';
        fetch(baseUrl + '/api/registries/' + activeRegistryId)
          .then(r => r.json())
          .then(data => renderDetail(data))
          .catch(() => {
            container.innerHTML = '<div class="reg-error">Unable to load registry. Check app URL and CORS settings.</div>';
          });
      } else {
        const params = new URLSearchParams();
        if (effectiveStoreId) params.set('store_id', effectiveStoreId);
        if (searchQuery) params.set('q', searchQuery);
        const listUrl = baseUrl + '/api/registries' + (params.toString() ? ('?' + params.toString()) : '');
        fetch(listUrl)
          .then(r => r.json())
          .then(data => renderList(data, searchQuery || ''))
          .catch(() => {
            container.innerHTML = '<div class="reg-error">Unable to load registries. Check app URL and CORS settings.</div>';
          });
      }
    }

    loadData();
  }

  const initial = findContainer();
  if (initial) {
    mount(initial);
    return;
  }

  let tries = 0;
  const timer = setInterval(() => {
    const next = findContainer();
    if (next) {
      clearInterval(timer);
      mount(next);
      return;
    }
    tries += 1;
    if (tries >= 120) {
      clearInterval(timer);
    }
  }, 250);
})();
  `);
});

// ── Standalone portal injection script ──────────────────────────────────────
// Load this on every page of the Ecwid storefront via Settings > Custom JavaScript.
// It silently detects logged-in customers with a linked registry and embeds the
// portal as an inline iframe inside their account section — no separate page needed.
app.get("/widget/portal.js", (req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.send(`
(function(){
  var baseUrl = "${BASE_URL}";
  var _plId   = 'registry-portal-inline-wrap';
  var _frameId = 'registry-portal-iframe';
  var _initDone = false;

  // ── Registry cart guard (inlined for zero-latency global coverage) ────────
  // portal.js is loaded on every storefront page via Settings > Custom JS.
  // Three triggers: OnCartChanged (real-time), OnPageLoaded (every navigation),
  // and a 3-second poll while a registry session is active. This covers cases
  // where OnCartChanged doesn't fire for native Ecwid Add-to-Cart buttons.
  if (!window.__regCartGuardInstalled) {
    window.__regCartGuardInstalled = true;

    var _guardPollTimer = null;

    function _guardShowToast() {
      var existing = document.getElementById('reg-guard-toast');
      if (existing) { clearTimeout(existing._timer); existing.parentNode && existing.parentNode.removeChild(existing); }
      var toast = document.createElement('div');
      toast.id = 'reg-guard-toast';
      toast.setAttribute('style', [
        'position:fixed','bottom:24px','left:50%','transform:translateX(-50%)',
        'background:#1a1a1a','color:#fff','padding:14px 20px 14px 16px',
        'border-radius:8px','font-family:inherit','font-size:14px',
        'z-index:2147483647','box-shadow:0 4px 20px rgba(0,0,0,0.35)',
        'max-width:420px','width:calc(100% - 48px)','text-align:center',
        'display:flex','align-items:flex-start','gap:12px'
      ].join(';'));
      var msg = document.createElement('span');
      msg.style.flex = '1';
      msg.textContent = 'Regular items cannot be added while registry items are in your cart. Visit the registry page to clear your cart first.';
      var close = document.createElement('button');
      close.setAttribute('style','background:none;border:none;color:#aaa;cursor:pointer;font-size:18px;line-height:1;padding:0;flex-shrink:0;');
      close.textContent = '\u00d7';
      close.onclick = function(){ toast.parentNode && toast.parentNode.removeChild(toast); };
      toast.appendChild(msg);
      toast.appendChild(close);
      document.body.appendChild(toast);
      toast._timer = setTimeout(function(){ toast.parentNode && toast.parentNode.removeChild(toast); }, 6000);
    }

    // Core check: calls Cart.get for canonical state, removes non-registry items.
    // Using Cart.get (rather than the OnCartChanged cart arg) is more reliable
    // for removal because we're not inside the cart-changed callback context.
    function _guardCheckCart() {
      var regItems = {};
      try { regItems = JSON.parse(localStorage.getItem('_reg_items') || '{}'); } catch(e) {}
      if (Object.keys(regItems).length === 0) {
        if (_guardPollTimer) { clearInterval(_guardPollTimer); _guardPollTimer = null; }
        return;
      }
      if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') return;
      Ecwid.Cart.get(function(cart) {
        var items = (cart && (cart.items || cart.products)) || [];
        // Refresh _cart_pids cache
        try {
          var pids = [];
          for (var i = 0; i < items.length; i++) {
            var p = (items[i] && items[i].product) || items[i];
            var id = String((p && p.id) || items[i].productId || 0);
            if (id !== '0') pids.push(id);
          }
          localStorage.setItem('_cart_pids', JSON.stringify(pids));
        } catch(e) {}
        // Re-read regItems in case it changed while waiting for Cart.get
        var ri = {};
        try { ri = JSON.parse(localStorage.getItem('_reg_items') || '{}'); } catch(e) {}
        if (Object.keys(ri).length === 0) return;
        var hadConflict = false;
        for (var j = items.length - 1; j >= 0; j--) {
          var product = (items[j] && items[j].product) || items[j];
          var pid = String((product && product.id) || items[j].productId || 0);
          if (pid === '0') continue;
          var tracked = ri[pid];
          if (!tracked || (Array.isArray(tracked) && tracked.length === 0)) {
            Ecwid.Cart.removeProduct(j);
            hadConflict = true;
          }
        }
        if (hadConflict) _guardShowToast();
      });
    }

    function _guardOnCartChanged(cart) {
      // Update _cart_pids from the event payload immediately (no async needed)
      try {
        var items = (cart && (cart.items || cart.products)) || [];
        var pids = [];
        for (var i = 0; i < items.length; i++) {
          var p = (items[i] && items[i].product) || items[i];
          var id = String((p && p.id) || items[i].productId || 0);
          if (id !== '0') pids.push(id);
        }
        localStorage.setItem('_cart_pids', JSON.stringify(pids));
      } catch(e) {}
      // Defer the actual removal so we're outside the OnCartChanged callback
      // context — some Ecwid versions ignore removeProduct calls made inline.
      setTimeout(_guardCheckCart, 150);
    }

    function _guardStartPoll() {
      if (_guardPollTimer) return;
      _guardPollTimer = setInterval(_guardCheckCart, 3000);
    }

    function _guardSubscribe() {
      if (!window.Ecwid || !Ecwid.OnCartChanged || !Ecwid.OnCartChanged.add) return false;
      Ecwid.OnCartChanged.add(_guardOnCartChanged);
      if (Ecwid.OnPageLoaded && Ecwid.OnPageLoaded.add) {
        Ecwid.OnPageLoaded.add(function(){ setTimeout(_guardCheckCart, 400); });
      }
      // Start polling — catches cases where OnCartChanged doesn't fire
      _guardStartPoll();
      // Immediate check for items already in cart
      setTimeout(_guardCheckCart, 500);
      return true;
    }

    if (!_guardSubscribe()) {
      var _gPoll = setInterval(function(){ if (_guardSubscribe()) clearInterval(_gPoll); }, 300);
    }
  }

  // All Ecwid page types that constitute "the account section"
  var _acctPages = ['ACCOUNT_SETTINGS','MY_ORDERS','ADDRESS_BOOK','FAVORITES',
                    'RESET_PASSWORD','SIGN_IN','ACCOUNT'];

  function _removePL(){
    var el = document.getElementById(_plId);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function _injectPortal(email){
    if (document.getElementById(_plId)) return;
    fetch(baseUrl + '/portal/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email: email })
      // No credentials:'include' — token in iframe URL handles auth
    })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      if (!data || !data.ok || !data.token) return; // no registry linked — stay silent
      if (document.getElementById(_plId)) return;   // guard against double-inject

      var wrap = document.createElement('div');
      wrap.id = _plId;
      wrap.style.cssText = 'margin:0 0 24px;';

      var iframe = document.createElement('iframe');
      iframe.id = _frameId;
      // Token in URL bootstraps the session as a first-party request —
      // no cross-site cookie needed (safe for Safari ITP / Chrome Privacy Sandbox).
      iframe.src = baseUrl + '/portal?token=' + encodeURIComponent(data.token);
      iframe.style.cssText = 'width:100%;min-height:400px;border:none;display:block;overflow:hidden;';
      iframe.scrolling = 'no';
      iframe.frameBorder = '0';
      wrap.appendChild(iframe);

      // Auto-resize the iframe to its content via postMessage
      window.addEventListener('message', function(evt){
        if (evt.data && evt.data.type === 'registry-portal-height'){
          iframe.style.height = (Number(evt.data.height) + 40) + 'px';
        }
      });

      // Insert before the Ecwid store container, or before the first Ecwid widget,
      // or prepend to body as a last resort.
      var storeEl = document.querySelector('[id^="my-store-"]') ||
                    document.querySelector('[class*="ecwid"]');
      if (storeEl && storeEl.parentNode){
        storeEl.parentNode.insertBefore(wrap, storeEl);
      } else {
        document.body.insertAdjacentElement('afterbegin', wrap);
      }
    })
    .catch(function(){});
  }

  function _checkPage(page){
    _removePL();
    if (!page) return;
    if (_acctPages.indexOf(page.type) === -1) return;
    if (!window.Ecwid || !Ecwid.Customer) return;
    Ecwid.Customer.get(function(customer){
      if (customer && customer.email) _injectPortal(customer.email);
    });
  }

  function _checkCurrentPage(){
    if (!window.Ecwid) return;
    // Ecwid.pages.currentPage is available after the API loads
    if (Ecwid.pages && Ecwid.pages.currentPage){
      _checkPage(Ecwid.pages.currentPage);
    }
  }

  function _init(){
    if (_initDone) return;
    _initDone = true;
    // Register for future SPA page changes
    if (Ecwid.OnPageLoad)   Ecwid.OnPageLoad.add(_checkPage);
    if (Ecwid.OnPageLoaded) Ecwid.OnPageLoaded.add(_checkPage);
    // Re-check when the customer signs in while already on an account page
    if (Ecwid.OnSetProfile){
      Ecwid.OnSetProfile.add(function(customer){
        if (!customer || !customer.email) return;
        if (Ecwid.pages && Ecwid.pages.currentPage) _checkPage(Ecwid.pages.currentPage);
      });
    }
    // Check the page the user is ALREADY on (initial load or late script injection)
    _checkCurrentPage();
  }

  // hashchange fires on Ecwid SPA navigation in some store setups
  window.addEventListener('hashchange', function(){ setTimeout(_checkCurrentPage, 350); });
  window.addEventListener('popstate',   function(){ setTimeout(_checkCurrentPage, 350); });

  // ── Bootstrap ────────────────────────────────────────────────────────────
  // KEY FIX: if Ecwid is already on the page and fully loaded, call _init
  // directly — OnAPILoaded will NOT fire again after the fact.
  if (window.Ecwid && typeof Ecwid.OnAPILoaded !== 'undefined'){
    Ecwid.OnAPILoaded.add(_init); // still register in case it fires after us
    _init();                       // also call now in case it already fired
  } else {
    // Ecwid not yet defined — poll until it appears, then hook in
    var _t = setInterval(function(){
      if (window.Ecwid && typeof Ecwid.OnAPILoaded !== 'undefined'){
        clearInterval(_t);
        Ecwid.OnAPILoaded.add(_init);
        _init();
      }
    }, 300);
  }
})();
  `);
});

app.get("/health", (req, res) => res.send("ok"));

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.listen(PORT, () => {
  console.log(`Registry app running at ${BASE_URL}`);
  // Railway volumes mount after the process starts; retry a few times
  const delays = [5000, 15000, 30000];
  delays.forEach(ms => setTimeout(() => deployCraneSection(), ms));
});

// ─── Crane section deploy ─────────────────────────────────────────────────────
let craneDeployed = false;
function deployCraneSection(overrideStoreId) {
  if (craneDeployed) return;
  if (!ECWID_CLIENT_ID || !ECWID_CLIENT_SECRET) {
    console.log("[crane] skipping — ECWID_CLIENT_ID or ECWID_CLIENT_SECRET not set");
    return;
  }
  const storeId = overrideStoreId || (getAllStores()[0] || {}).store_id || LEGACY_ECWID_STORE_ID;
  if (!storeId) {
    console.log("[crane] skipping — no store_id available yet (will retry when a store is added)");
    return;
  }
  craneDeployed = true;
  console.log(`[crane] deploying section for store_id=${storeId}`);

  const configPath = path.join(__dirname, "crane-section", "crane.config.json");
  const cfg = { app_client_id: ECWID_CLIENT_ID, app_secret_key: ECWID_CLIENT_SECRET, store_id: storeId };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");

  // Build first, then deploy
  const craneCwd = path.join(__dirname, "crane-section");
  // Use local crane (3.1.0) — npx @latest pulls 3.2.1 which has a breaking change
  exec("npx @lightspeed/crane build && npx @lightspeed/crane deploy", {
    cwd: craneCwd,
    timeout: 120000,
  }, (err, stdout, stderr) => {
    if (stderr) console.log(`[crane] stderr: ${stderr.trim()}`);
    if (stdout) console.log(`[crane] stdout: ${stdout.trim()}`);
    if (err) {
      craneDeployed = false; // allow retry
      console.log(`[crane] deploy failed (exit code ${err.code}): ${err.message}`);
    } else {
      console.log("[crane] deploy succeeded");
    }
  });
}
