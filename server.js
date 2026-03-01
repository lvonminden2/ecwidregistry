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

const app = express();
app.set("trust proxy", 1); // Required for Railway/Heroku — trusts X-Forwarded-Proto for secure cookies
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/widget/registry.js") {
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

  const cols = db.prepare("PRAGMA table_info(registry)").all().map((c) => c.name);
  if (!cols.includes("store_id")) {
    db.exec("ALTER TABLE registry ADD COLUMN store_id TEXT");
  }
  if (!cols.includes("registry_type")) {
    db.exec("ALTER TABLE registry ADD COLUMN registry_type TEXT NOT NULL DEFAULT 'in_store'");
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
  return res.render("admin/index", { registries });
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
  res.render("admin/index", { registries });
});

app.get("/admin/setup", (req, res) => {
  res.render("admin/setup", {
    baseUrl: BASE_URL,
    storeId: ECWID_STORE_ID
  });
});

app.get("/admin/registry/new", (req, res) => {
  res.render("admin/new");
});

app.post("/admin/registry", (req, res) => {
  const { display_name, event_date, registry_type } = req.body;
  const storeId = req.ecwid?.store_id || ECWID_STORE_ID || null;
  const type = registry_type === "online" ? "online" : "in_store";
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
  res.render("admin/detail", { registry, items, purchases, skuSearch, skuResults, skuError, actionError, actionInfo });
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

// Webhook placeholder for Ecwid order created
app.post("/webhooks/ecwid/order-created", express.raw({ type: "*/*" }), (req, res) => {
  // Verify Ecwid HMAC-SHA256 signature when client secret is configured
  if (ECWID_CLIENT_SECRET) {
    const sig = req.headers["x-ecwid-signature-sha256"] || "";
    const expected = crypto
      .createHmac("sha256", ECWID_CLIENT_SECRET)
      .update(req.body)
      .digest("base64");
    if (sig !== expected) {
      console.log("[webhook] signature mismatch — rejected");
      return res.status(401).send("Invalid signature");
    }
  }

  let order;
  try {
    order = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  if (!order) return res.status(400).send("Missing payload");

  const extraFields = order?.orderExtraFields || [];
  const registryIdField = extraFields.find(
    (f) =>
      f.fieldKey === "registry_id" ||
      f.key === "registry_id" ||
      f.id === "registry_id" ||
      f.name === "registry_id"
  );
  const registryId = registryIdField ? Number(registryIdField.value || registryIdField.text || registryIdField.valueText) : null;

  if (registryId && Array.isArray(order.items)) {
    for (const item of order.items) {
      db.prepare(
        "INSERT INTO registry_purchase (registry_id, product_id, product_name, product_sku, qty, buyer_name, buyer_email, notes, off_registry, channel, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        registryId,
        Number(item.productId),
        item.name || null,
        item.sku || null,
        Number(item.quantity || 1),
        order.billingPerson?.name || null,
        order.email || null,
        null,
        0,
        "online",
        Number(order.orderNumber || order.id || null)
      );
    }
  }

  res.status(200).send("ok");
});

// Storefront widget JS
app.get("/widget/registry.js", (req, res) => {
  res.type("application/javascript");
  res.send(`
(function(){
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

  function setRegistryExtraFields(registry){
    if (!window.ec || !ec.order || !ec.order.extraFields) return;
    ec.order.extraFields.registry_id = {
      title: 'Registry ID',
      type: 'text',
      required: false,
      orderDetailsDisplaySection: 'hidden',
      value: String(registry.id)
    };
    ec.order.extraFields.registry_name = {
      title: 'Registry Name',
      type: 'text',
      required: false,
      orderDetailsDisplaySection: 'hidden',
      value: registry.display_name
    };
    if (window.Ecwid && Ecwid.refreshConfig) {
      Ecwid.refreshConfig();
    }
  }

  function mount(container){
    if (container.getAttribute('data-registry-mounted') === '1') return;
    container.setAttribute('data-registry-mounted', '1');
    container.classList.add('registry-root');

    const isEmbed = container.getAttribute('data-embed') === 'true';
    const inIframe = window.self !== window.top;
    const storeId = container.getAttribute('data-store-id') || '';
    let activeRegistryId = container.getAttribute('data-registry-id') || '';

    let searchTimer = null;

    function renderList(data, searchValue){
      const effectiveStoreId = storeId || defaultStoreId || '';
      const detailSuffix = effectiveStoreId ? ('?store_id=' + encodeURIComponent(String(effectiveStoreId))) : '';

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
        const typeBadge = r.registry_type === 'online'
          ? '<span class="reg-type-badge reg-type-online">Online</span>'
          : '<span class="reg-type-badge reg-type-instore">In-store</span>';
        if (isEmbed) {
          return (
            '<div class="reg-card">' +
              '<div class="reg-name">' + esc(r.display_name) + ' ' + typeBadge + '</div>' +
              '<div class="reg-meta">' + esc(fmtDate(r.event_date)) + ' · ' + r.item_count + ' items</div>' +
              '<div class="reg-actions"><button class="reg-btn reg-open-btn" data-open-id="' + r.id + '">View Registry</button></div>' +
            '</div>'
          );
        }
        return (
          '<a class="reg-card" href="/registry/' + r.id + detailSuffix + '">' +
            '<div class="reg-name">' + esc(r.display_name) + ' ' + typeBadge + '</div>' +
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
        node.textContent = message || '';
      }
      ensureCartApi(effectiveStoreId).then(function(){
        setRegistryExtraFields(registry);
      }).catch(function(){});

      const isOnline = registry.registry_type === 'online';
      const rows = items.map(item => {
        const stillNeeded = Number(item.still_needed ?? Math.max(0, (item.desired_qty || 0) - (item.purchased_qty || 0)));
        const action = isOnline
          ? '<button class="reg-btn" data-product-id="' + item.product_id + '">Add to cart</button>'
          : '<span class="reg-instore-note">Available in store</span>';
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
              setRegistryExtraFields(registry);
              let settled = false;
              function finish(ok, message){
                if (settled) return;
                settled = true;
                setStatus(message || (ok ? 'Added to cart.' : 'Failed to add to cart.'), !ok);
                btn.disabled = false;
                btn.textContent = originalText;
              }

              function cartContainsProduct(targetId){
                return new Promise((resolve) => {
                  if (!window.Ecwid || !Ecwid.Cart || typeof Ecwid.Cart.get !== 'function') {
                    return resolve(null);
                  }
                  try {
                    Ecwid.Cart.get(function(cart){
                      const items = (cart && (cart.items || cart.products)) || [];
                      const found = Array.isArray(items) && items.some((it) => {
                        const id = Number(it?.productId || it?.id || it?.product?.id || 0);
                        return id === Number(targetId);
                      });
                      resolve(found);
                    });
                  } catch {
                    resolve(null);
                  }
                });
              }

              function primaryAttempt(){
                try {
                  Ecwid.Cart.addProduct(productId, 1, function(success){
                    finish(success !== false, success !== false ? 'Added to cart.' : 'Ecwid did not add this item to cart.');
                  });
                } catch (err) {
                  console.log('[registry] add to cart primary error', err);
                  secondaryAttempt();
                }
              }

              function secondaryAttempt(){
                if (settled) return;
                cartContainsProduct(productId).then(function(found){
                  if (found === true) {
                    finish(true, 'Added to cart.');
                    return;
                  }
                  try {
                    Ecwid.Cart.addProduct(productId, function(success){
                      finish(success !== false, success !== false ? 'Added to cart.' : 'Ecwid did not add this item to cart.');
                    });
                  } catch (err) {
                    console.log('[registry] add to cart secondary error', err);
                    finish(false, 'Failed to add to cart.');
                  }
                });
              }

              primaryAttempt();

              setTimeout(function(){
                if (!settled) {
                  secondaryAttempt();
                }
              }, 1200);

              setTimeout(function(){
                if (!settled) {
                  cartContainsProduct(productId).then(function(found){
                    if (found === true) {
                      finish(true, 'Added to cart.');
                    } else {
                      finish(false, 'Could not confirm add to cart. Try from the main storefront page.');
                    }
                  });
                }
              }, 3500);
            })
            .catch(function(){
              setStatus('Cart API unavailable on this page. Open this inside your Ecwid storefront.', true);
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

app.get("/health", (req, res) => res.send("ok"));

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.listen(PORT, () => {
  console.log(`Registry app running at ${BASE_URL}`);
});
