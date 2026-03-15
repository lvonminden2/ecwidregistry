import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import fs from "fs";
import dotenv from "dotenv";
import session from "express-session";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ECWID_STORE_ID = process.env.ECWID_STORE_ID || "STORE_ID_PLACEHOLDER";
const ECWID_CLIENT_ID = process.env.ECWID_CLIENT_ID || "";
const ECWID_ACCESS_TOKEN = process.env.ECWID_ACCESS_TOKEN || "";
const ECWID_CLIENT_SECRET = process.env.ECWID_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_session_secret";
const ALLOW_NO_ECWID = (process.env.ALLOW_NO_ECWID || "true").toLowerCase() === "true";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// URL of the Ecwid storefront page where the widget is embedded.
// If set, all public-facing registry links point here instead of the standalone /registry page.
const PUBLIC_REGISTRY_URL = process.env.PUBLIC_REGISTRY_URL || "";
// URL of the page where the registry widget is embedded.
const REGISTRY_PAGE_URL = process.env.REGISTRY_PAGE_URL || '';

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
  if (req.path.startsWith("/api/") || req.path === "/widget/registry.js" || req.path === "/widget/portal.js") {
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
  const itemCols = db.prepare("PRAGMA table_info(registry_item)").all().map((c) => c.name);
  if (!itemCols.includes("product_sku")) {
    db.exec("ALTER TABLE registry_item ADD COLUMN product_sku TEXT");
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
});
init();

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
  res.locals.ecwid = req.ecwid;
  res.locals.ecwidClientId = ECWID_CLIENT_ID;
  // Resolved public registry base URL: Ecwid storefront page if configured, else our own /registry
  res.locals.publicRegistryUrl = PUBLIC_REGISTRY_URL || (BASE_URL + "/registry");
  next();
});

function getRegistryById(id) {
  return db.prepare("SELECT * FROM registry WHERE id = ?").get(id);
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
    console.log(`[ecwid-iframe] payload ok store_id=${data.store_id || data.storeId || ""}`);
    req.session.ecwid = {
      store_id: String(data.store_id || data.storeId || ""),
      access_token: data.access_token || data.accessToken || "",
      public_token: data.public_token || data.publicToken || "",
      lang: data.lang || ""
    };
  } else if (payload) {
    console.log("[ecwid-iframe] no ECWID_CLIENT_SECRET — skipping payload verification");
  }

  // Render admin directly (avoid redirect — some iframe hosts treat 302 as an error)
  const registries = db.prepare("SELECT * FROM registry ORDER BY created_at DESC").all();
  return res.render("admin/index", { registries, actionError: null, actionInfo: null });
});

// Admin routes
app.get("/admin", (req, res) => {
  if (!req.ecwid && !ALLOW_NO_ECWID) {
    return res.status(401).send("Not authorized");
  }
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
  const storeId = req.ecwid?.store_id || ECWID_STORE_ID || null;
  const type = "online";
  const stmt = db.prepare(
    "INSERT INTO registry (display_name, event_date, registry_type, store_id) VALUES (?, ?, ?, ?)"
  );
  const info = stmt.run(display_name?.trim(), event_date || null, type, storeId);
  res.redirect(`/admin/registry/${info.lastInsertRowid}`);
});

app.get("/admin/registry/:id", async (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryById(registryId);
  if (!registry) return res.status(404).send("Not found");
  const items = getRegistryItems(registryId);
  const purchases = getRegistryPurchases(registryId);
  const skuSearch = String(req.query.sku || "").trim();
  const actionError = String(req.query.error || "").trim();
  const actionInfo = String(req.query.info || "").trim();
  let skuResults = [];
  let skuError = null;
  if (skuSearch) {
    const storeId = req.ecwid?.store_id || ECWID_STORE_ID;
    const token = req.ecwid?.access_token || ECWID_ACCESS_TOKEN;
    const result = await searchEcwidProductsBySku(skuSearch, storeId, token);
    skuResults = result.items;
    skuError = result.error;
  }
  const registrantAccount = db
    .prepare("SELECT * FROM registry_account WHERE registry_id = ?")
    .get(registryId) || null;
  const portalLoginUrl = `${BASE_URL}/portal/login`;
  const portalWidgetUrl = `${BASE_URL}/widget/portal.js`;
  const cartWidgetUrl = `${BASE_URL}/widget/cart.js`;
  res.render("admin/detail", { registry, items, purchases, skuSearch, skuResults, skuError, actionError, actionInfo, registrantAccount, portalLoginUrl, portalWidgetUrl, cartWidgetUrl, ecwidStoreId: ECWID_STORE_ID || '' });
});

app.post("/admin/registry/:id/edit", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryById(registryId);
  if (!registry) return res.status(404).send("Not found");
  const name = String(req.body.display_name || "").trim();
  if (!name) {
    const msg = encodeURIComponent("Registry name cannot be empty.");
    return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
  }
  const date = String(req.body.event_date || "").trim() || null;
  db.prepare(
    "UPDATE registry SET display_name = ?, event_date = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name, date, registryId);
  const msg = encodeURIComponent("Registry updated.");
  return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
});

app.post("/admin/registry/:id/items", async (req, res) => {
  const registryId = Number(req.params.id);
  const { product_id, product_name, product_sku, desired_qty } = req.body;
  const storeId = req.ecwid?.store_id || ECWID_STORE_ID;
  const token = req.ecwid?.access_token || ECWID_ACCESS_TOKEN;
  let productId = Number(product_id || 0);
  let name = product_name?.trim() || null;
  let sku = product_sku?.trim() || null;

  if (!productId && sku) {
    const bySku = await fetchEcwidProductBySku(sku, storeId, token);
    if (!bySku.product) {
      const msg = encodeURIComponent(bySku.error || "Could not find product by SKU.");
      return res.redirect(`/admin/registry/${registryId}?error=${msg}`);
    }
    productId = Number(bySku.product.id);
    if (!name) name = bySku.product.name || null;
    if (!sku) sku = bySku.product.sku || null;
  }

  if (productId && (!name || !sku)) {
    const product = await fetchEcwidProduct(productId, storeId, token);
    if (product) {
      if (!name) name = product.name || null;
      if (!sku) sku = product.sku || null;
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
      "UPDATE registry_item SET desired_qty = ?, product_name = ?, product_sku = ? WHERE id = ?"
    ).run(
      existingItem.desired_qty + desiredQty,
      name || existingItem.product_name,
      sku || existingItem.product_sku,
      existingItem.id
    );
    const msg = encodeURIComponent("Item already existed. Desired quantity was increased.");
    return res.redirect(`/admin/registry/${registryId}?info=${msg}`);
  }

  db.prepare(
    "INSERT INTO registry_item (registry_id, product_id, product_name, product_sku, desired_qty) VALUES (?, ?, ?, ?, ?)"
  ).run(registryId, productId, name, sku, desiredQty);
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
  const registry = getRegistryById(registryId);
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
  const registry = getRegistryById(registryId);
  if (!registry) return res.status(404).send("Not found");
  const items = getRegistryItems(registryId);
  res.render("admin/print", { registry, items });
});

// ── Registrant account management (admin) ─────────────────────────────────────
app.post("/admin/registry/:id/account", async (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryById(registryId);
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
  if (ECWID_ACCESS_TOKEN && ECWID_STORE_ID) {
    try {
      const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/customers?email=${encodeURIComponent(email)}&limit=1`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${ECWID_ACCESS_TOKEN}` } });
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
  const registry = getRegistryById(registryId);
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
  const registry = getRegistryById(registryId);
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
  res.render("portal/login", { error, ecwidStoreId: ECWID_STORE_ID });
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
    const storeId = ECWID_STORE_ID;
    const token = ECWID_ACCESS_TOKEN;
    const result = await fetchEcwidProductBySku(sku, storeId, token);
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
  const storeId = req.query.store_id || ECWID_STORE_ID || "";
  res.render("public/registry", { baseUrl: BASE_URL, storeId });
});

app.get("/registry/:id", (req, res) => {
  const registryId = Number(req.params.id);
  const storeId = req.query.store_id || ECWID_STORE_ID || "";
  res.render("public/registry-detail", { baseUrl: BASE_URL, registryId, storeId });
});

app.get("/registry-embed", (req, res) => {
  const storeId = req.query.store_id || ECWID_STORE_ID || "";
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

app.get("/api/registries/:id", (req, res) => {
  const registryId = Number(req.params.id);
  const registry = getRegistryById(registryId);
  if (!registry || registry.status !== "active") return res.status(404).json({ error: "Not found" });
  const items = getRegistryItems(registryId);
  // registry_type is already on the registry row from getRegistryById
  res.json({ registry, items });
});

// ─── Process a full Ecwid order: match items to registries, record purchases,
// and annotate the Ecwid order with staff notes. Used by both the webhook and
// the manual sync endpoint.
async function processEcwidOrder(order) {
  const orderNumber = Number(order.orderNumber || order.vendorOrderNumber || order.id || 0);
  if (!orderNumber) return { recorded: 0, error: "no order number" };

  const extraFields = order?.orderExtraFields || [];
  const registryIdField = extraFields.find(
    (f) => f.key === "registry_id" || f.fieldKey === "registry_id" || f.id === "registry_id" || f.name === "registry_id"
  );
  const hintRegistryId = registryIdField
    ? Number(registryIdField.value || registryIdField.text || registryIdField.valueText)
    : null;

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
      const dup = db
        .prepare("SELECT id FROM registry_purchase WHERE order_id = ? AND product_id = ? AND registry_id = ?")
        .get(orderNumber, productId, registryId);
      if (dup) continue;

      db.prepare(
        "INSERT INTO registry_purchase (registry_id, product_id, product_name, product_sku, qty, buyer_name, buyer_email, notes, off_registry, channel, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        registryId, productId,
        item.name || null, item.sku || null,
        Number(item.quantity || 1),
        order.billingPerson?.name || order.shippingPerson?.name || null,
        order.email || null,
        null, 0, "online", orderNumber
      );
      recorded++;
      matchedRegistries.add(registryId);
    }
  }

  // Annotate the Ecwid order with per-item and order-level notes
  if (matchedRegistries.size > 0 && ECWID_ACCESS_TOKEN && ECWID_STORE_ID && ECWID_STORE_ID !== "STORE_ID_PLACEHOLDER") {
    try {
      const regNames = [];
      for (const rid of matchedRegistries) {
        const reg = db.prepare("SELECT display_name FROM registry WHERE id = ?").get(rid);
        if (reg) regNames.push(reg.display_name);
      }

      // Build detailed privateAdminNotes listing which items are registry gifts
      const giftItemNames = orderItems
        .filter(it => matchedProductIds.has(Number(it.productId)))
        .map(it => it.name || it.sku || `#${it.productId}`);
      const note = `GIFT REGISTRY ORDER — ${regNames.join(", ")}\nRegistry items: ${giftItemNames.join(", ")}`;

      // Update per-item notes so clerks see which items are gifts
      const updatedItems = orderItems.map(it => {
        const pid = Number(it.productId);
        if (matchedProductIds.has(pid)) {
          const regLabel = "Gift Registry: " + regNames.join(", ");
          return { ...it, note: it.note ? it.note + " | " + regLabel : regLabel };
        }
        return it;
      });

      const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/orders/${orderNumber}`;
      await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ECWID_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ privateAdminNotes: note, items: updatedItems })
      });
      console.log(`[order] #${orderNumber} — annotated ${giftItemNames.length} registry item(s): ${giftItemNames.join(", ")}`);
    } catch (err) {
      console.log(`[order] #${orderNumber} — annotation error: ${err.message}`);
    }
  }

  return { recorded, registries: [...matchedRegistries] };
}

// Fetch full order details from Ecwid REST API
async function fetchEcwidOrder(orderId) {
  if (!ECWID_ACCESS_TOKEN || !ECWID_STORE_ID || ECWID_STORE_ID === "STORE_ID_PLACEHOLDER") {
    return null;
  }
  const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/orders/${orderId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ECWID_ACCESS_TOKEN}` } });
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

  console.log(`[webhook] fetching full order ${orderId} from Ecwid API...`);
  const order = await fetchEcwidOrder(orderId);
  if (!order) {
    console.log(`[webhook] could not fetch order ${orderId}`);
    return;
  }

  const result = await processEcwidOrder(order);
  console.log(`[webhook] order #${orderId} — recorded ${result.recorded} registry purchase(s)`);
});

// ─── Manual sync: fetch recent orders from Ecwid and process any that contain
// registry items. Use this to backfill orders placed before the webhook was fixed.
app.post("/admin/sync-orders", async (req, res) => {
  if (!ECWID_ACCESS_TOKEN || !ECWID_STORE_ID || ECWID_STORE_ID === "STORE_ID_PLACEHOLDER") {
    return res.redirect("/admin?error=" + encodeURIComponent("Ecwid API credentials not configured."));
  }
  try {
    const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/orders?limit=50&sortBy=DATE_CREATED&sortDirection=DESC`;
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${ECWID_ACCESS_TOKEN}` } });
    if (!apiRes.ok) {
      return res.redirect("/admin?error=" + encodeURIComponent(`Ecwid API error: ${apiRes.status}`));
    }
    const data = await apiRes.json();
    const orders = data?.items || [];
    let totalRecorded = 0;
    for (const order of orders) {
      const result = await processEcwidOrder(order);
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

// ─── Auto-sync: poll Ecwid for recent orders every 15 minutes ────────────────
if (ECWID_ACCESS_TOKEN && ECWID_STORE_ID && ECWID_STORE_ID !== "STORE_ID_PLACEHOLDER") {
  const AUTO_SYNC_INTERVAL = 15 * 60 * 1000; // 15 minutes
  setInterval(async () => {
    try {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const url = `https://app.ecwid.com/api/v3/${ECWID_STORE_ID}/orders?createdFrom=${encodeURIComponent(since)}&limit=50&sortBy=DATE_CREATED&sortDirection=DESC`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${ECWID_ACCESS_TOKEN}` } });
      if (!res.ok) return;
      const data = await res.json();
      const orders = data?.items || [];
      let recorded = 0;
      for (const order of orders) {
        const result = await processEcwidOrder(order);
        recorded += result.recorded;
      }
      if (recorded > 0) console.log(`[auto-sync] recorded ${recorded} new registry purchase(s)`);
    } catch (err) {
      console.log(`[auto-sync] error: ${err.message}`);
    }
  }, AUTO_SYNC_INTERVAL);
  console.log("[auto-sync] enabled — polling every 15 minutes");
}

// ─── Lightweight storefront cart script ──────────────────────────────────────
// Per-item registry labeling for Ecwid cart pages.
// Reads _reg_items from localStorage (written by registry.js when items are added).
// Labels individual cart items with their registry name and shows a disclaimer.
// Usage: <script src="https://your-app/widget/cart.js"></script>
app.get("/widget/cart.js", (req, res) => {
  res.type("application/javascript");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.send(`
(function(){
  console.log('[registry-cart] v7 loaded');

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
  // Format: { "productId": { rid: number, name: "Registry Name" }, ... }
  function getRegItems() {
    try {
      return JSON.parse(localStorage.getItem('_reg_items') || '{}');
    } catch(e) { return {}; }
  }

  // ── Per-item badge injection ──
  // Specific selectors for known Ecwid cart item name elements
  var _nameSelectors = [
    '[data-hook="product-title"]',
    '[data-hook="cart-item-title"]',
    '.ec-cart-item__name',
    '.ec-cart-item .ec-cart-item__title',
    '[class*="cart-item"] [class*="title"]',
    '[class*="cart-item"] [class*="name"]',
    '[class*="cartProduct"] [class*="title"]',
    '[class*="cartProduct"] [class*="name"]'
  ];

  var _labelDebugOnce = false;

  function addBadge(el, regName) {
    if (el.getAttribute('data-reg-labeled')) return false;
    el.setAttribute('data-reg-labeled', '1');
    var badge = document.createElement('span');
    badge.className = 'reg-cart-badge';
    badge.textContent = '\\uD83C\\uDF81 ' + regName;
    badge.style.cssText = 'display:inline-block;margin-left:8px;padding:2px 7px;background:#f0f4f0;border:1px solid #c8d8c8;border-radius:3px;font-size:0.8em;color:#2a6e3f;font-weight:500;white-space:nowrap;';
    el.appendChild(badge);
    return true;
  }

  function matchesName(text, nameToReg) {
    var result = null;
    Object.keys(nameToReg).forEach(function(n) {
      if (text === n || text.startsWith(n)) result = nameToReg[n];
    });
    return result;
  }

  function labelItems() {
    var regItems = getRegItems();
    if (!Object.keys(regItems).length) return;
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') return;
    Ecwid.Cart.get(function(cart) {
      var cartItems = (cart && cart.items) || [];
      if (!Array.isArray(cartItems) || !cartItems.length) return;
      // Build map of product name → registry name for items in cart
      var nameToReg = {};
      cartItems.forEach(function(it) {
        var product = (it && it.product) || it;
        var pid = String((product && product.id) || it.productId || 0);
        var name = (product && product.name) || it.name || '';
        if (regItems[pid] && name) {
          nameToReg[name] = regItems[pid].name || 'Gift Registry';
        }
      });
      if (!Object.keys(nameToReg).length) return;

      // Debug: log once so we can diagnose selector issues
      if (!_labelDebugOnce) {
        _labelDebugOnce = true;
        console.log('[registry-cart] Looking for names:', Object.keys(nameToReg));
        _nameSelectors.forEach(function(sel) {
          var found = document.querySelectorAll(sel);
          if (found.length) console.log('[registry-cart] Selector "' + sel + '" matched', found.length, 'elements');
        });
      }

      // Phase 1: Try specific selectors
      var labeled = 0;
      _nameSelectors.forEach(function(sel) {
        document.querySelectorAll(sel).forEach(function(el) {
          var text = (el.textContent || '').trim();
          if (!text) return;
          var regName = matchesName(text, nameToReg);
          if (regName && addBadge(el, regName)) labeled++;
        });
      });

      // Phase 2: Fallback — scan all links and text elements in the store container
      // for exact product name matches (broader search if specific selectors miss)
      if (labeled === 0) {
        var storeEl = findStoreEl();
        var searchRoot = storeEl || document.body;
        var candidates = searchRoot.querySelectorAll('a, span, div, p, h1, h2, h3, h4, h5, h6, td, li');
        candidates.forEach(function(el) {
          // Skip elements that are too large (containers) — only target leaf-ish elements
          if (el.children.length > 3) return;
          var text = (el.textContent || '').trim();
          if (!text || text.length > 200) return;
          var regName = matchesName(text, nameToReg);
          if (!regName) return;
          // Only badge if this element directly contains the text (not a distant parent)
          var direct = false;
          for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 3 && (el.childNodes[i].textContent || '').trim() === text) {
              direct = true;
              break;
            }
          }
          // Also accept if the element has few children and text matches
          if (!direct && el.children.length <= 1) direct = true;
          if (direct && addBadge(el, regName)) {
            labeled++;
            console.log('[registry-cart] Fallback badge on:', el.tagName, el.className);
          }
        });
        if (labeled > 0) {
          console.log('[registry-cart] Labeled', labeled, 'items via fallback scan');
        }
      }
    });
  }

  // ── Disclaimer shown on cart/checkout pages when registry items are present ──
  function showDisclaimer() {
    var regItems = getRegItems();
    var el = document.getElementById('_reg-disclaimer');
    if (!Object.keys(regItems).length) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    // Check if any registry items are actually in the cart
    if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') return;
    Ecwid.Cart.get(function(cart) {
      var cartItems = (cart && cart.items) || [];
      var hasRegItem = cartItems.some(function(it) {
        var product = (it && it.product) || it;
        var pid = String((product && product.id) || it.productId || 0);
        return !!regItems[pid];
      });
      var existing = document.getElementById('_reg-disclaimer');
      if (!hasRegItem) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        return;
      }
      if (existing) return; // already showing
      var box = document.createElement('div');
      box.id = '_reg-disclaimer';
      box.style.cssText = 'background:#f0f7f0;border:1px solid #b8d8b8;border-radius:5px;padding:10px 16px;margin:0 0 12px;font-size:0.9em;color:#2a6e3f;font-family:sans-serif;';
      box.innerHTML = '\\uD83C\\uDF81 Items marked with \\uD83C\\uDF81 are gift registry purchases. These will be recorded as purchased on their respective registries upon checkout.';
      var storeEl = findStoreEl();
      if (storeEl && storeEl.parentNode) storeEl.parentNode.insertBefore(box, storeEl);
    });
  }

  // ── Run labeling + disclaimer on every tick ──
  // No page-type gating — the DOM selectors only match on cart pages anyway,
  // and Ecwid.Cart.get returns empty on non-cart contexts. This avoids the
  // race where OnPageLoad fires before cart.js registers its handler.
  setInterval(function() {
    labelItems();
    showDisclaimer();
  }, 2000);

  // Also run once on startup after a short delay
  setTimeout(function() { labelItems(); showDisclaimer(); }, 1000);
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
  const defaultStoreId = "${ECWID_STORE_ID}";

  // Inject store fonts if not already present
  if (!document.querySelector('link[data-registry-fonts]')) {
    const link = document.createElement('link');
    link.setAttribute('data-registry-fonts', '1');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=Prata&display=swap';
    document.head.appendChild(link);
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
  // in localStorage so cart.js can label it in the cart.
  function trackRegItem(productId, registry) {
    try {
      var regItems = JSON.parse(localStorage.getItem('_reg_items') || '{}');
      regItems[String(productId)] = { rid: registry.id, name: registry.display_name };
      localStorage.setItem('_reg_items', JSON.stringify(regItems));
    } catch(e) {}
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

  function mount(container){
    if (container.getAttribute('data-registry-mounted') === '1') return;
    container.setAttribute('data-registry-mounted', '1');
    container.classList.add('registry-root');

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
        return (
          '<div class="reg-item">' +
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
      container.innerHTML =
        '<div class="reg-header">' + esc(registry.display_name) + '</div>' +
        '<div class="reg-sub">' + esc(fmtDate(registry.event_date)) + '</div>' +
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
          ensureCartApi(effectiveStoreId)
            .then(function(){
              let settled = false;
              function finish(ok, message){
                if (settled) return;
                settled = true;
                // Remove cart-change listener
                try { if (window.Ecwid && Ecwid.OnCartChanged) Ecwid.OnCartChanged.remove(_onCartChanged); } catch(e){}
                if (ok) {
                  trackRegItem(productId, registry);
                  setStatus(message || 'Added to cart.', false);
                } else {
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
                  var id = Number(it?.productId || it?.id || it?.product?.id || 0);
                  return id === Number(productId);
                });
                if (found) finish(true, 'Added to cart.');
              }
              try { if (window.Ecwid && Ecwid.OnCartChanged) Ecwid.OnCartChanged.add(_onCartChanged); } catch(e){}

              // Fire addProduct — callback may or may not fire on Instant Sites
              console.log('[registry] adding product', productId);
              try {
                Ecwid.Cart.addProduct(productId, 1, function(success){
                  console.log('[registry] addProduct callback:', success);
                  finish(success !== false, success !== false ? 'Added to cart.' : 'Ecwid rejected this item.');
                });
              } catch (err) {
                console.log('[registry] addProduct error:', err);
              }

              // Fallback: assume success after 2s (item was likely added)
              setTimeout(function(){
                if (!settled) {
                  console.log('[registry] callback never fired, assuming success');
                  trackRegItem(productId, registry);
                  finish(true, 'Added to cart.');
                }
              }, 2000);
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
  res.send(`
(function(){
  var baseUrl = "${BASE_URL}";
  var _plId   = 'registry-portal-inline-wrap';
  var _frameId = 'registry-portal-iframe';
  var _initDone = false;
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
});
