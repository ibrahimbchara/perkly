const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const xlsx = require("xlsx");

const DB_PATH = path.join(__dirname, "data", "cards.db");
const EXCEL_PATH = path.join(__dirname, "Bank Cards V2.1 - Travel Sample.xlsx");

fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "nan" || text.toLowerCase() === "none" || text === "0") {
    return "";
  }
  return text;
}

function parseNumber(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) {
    return 0;
  }
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function initDb() {
  await dbRun("PRAGMA foreign_keys = ON");
  await dbRun(
    `CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_category TEXT,
      sub_category TEXT,
      program TEXT,
      bank_name TEXT,
      product TEXT,
      minimum_salary REAL,
      value_metric TEXT,
      value_calculation TEXT,
      provider TEXT,
      annual_fee REAL,
      joining_fee REAL,
      extra_fees TEXT,
      core_perks TEXT,
      secondary_perks TEXT,
      extra_perks TEXT,
      card_type TEXT,
      current_offer TEXT,
      product_page TEXT,
      old_notes TEXT
    )`
  );
  await dbRun(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  );
}

async function seedFromExcel() {
  if (!fs.existsSync(EXCEL_PATH)) {
    return;
  }
  const row = await dbGet("SELECT COUNT(*) as count FROM cards");
  if (row && row.count > 0) {
    return;
  }

  const workbook = xlsx.readFile(EXCEL_PATH);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  for (const entry of rows) {
    const cardCategory = normalizeText(entry["Card Category"]);
    if (!cardCategory || cardCategory === "Card Category") {
      continue;
    }
    const subCategory = normalizeText(entry["Sub Category"]);
    if (subCategory === "Sub Category") {
      continue;
    }

    await dbRun(
      `INSERT INTO cards (
        card_category,
        sub_category,
        program,
        bank_name,
        product,
        minimum_salary,
        value_metric,
        value_calculation,
        provider,
        annual_fee,
        joining_fee,
        extra_fees,
        core_perks,
        secondary_perks,
        extra_perks,
        card_type,
        current_offer,
        product_page,
        old_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        cardCategory,
        subCategory,
        normalizeText(entry["Program"]),
        normalizeText(entry["Bank Name"]),
        normalizeText(entry["Product"]),
        parseNumber(entry["Minimum Salary"]),
        normalizeText(entry["Value Metric"]),
        normalizeText(entry["Value Calculation"]),
        normalizeText(entry["Provider"]),
        parseNumber(entry["Annual Fee"]),
        parseNumber(entry["Joining Fee"]),
        normalizeText(entry["Extra Fees"]),
        normalizeText(entry["Core Perks"]),
        normalizeText(entry["Secondary Perks"]),
        normalizeText(entry["Extra Perks"]),
        normalizeText(entry["Card type"]),
        normalizeText(entry["Current Offer"]),
        normalizeText(entry["Product Page"]),
        normalizeText(entry["Old Notes"]),
      ]
    );
  }
}

async function fetchDistinct(column, filters = {}) {
  let query = `SELECT DISTINCT ${column} as value FROM cards WHERE ${column} != ''`;
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) {
      continue;
    }
    query += ` AND ${key} = ?`;
    params.push(value);
  }
  query += ` ORDER BY ${column}`;
  const rows = await dbAll(query, params);
  return rows.map((row) => row.value).filter(Boolean);
}

async function getCards(filters = {}) {
  let query = "SELECT * FROM cards WHERE 1=1";
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) {
      continue;
    }
    query += ` AND ${key} = ?`;
    params.push(value);
  }
  query += " ORDER BY product";
  return dbAll(query, params);
}

async function insertCard(data) {
  await dbRun(
    `INSERT INTO cards (
      card_category,
      sub_category,
      program,
      bank_name,
      product,
      minimum_salary,
      value_metric,
      value_calculation,
      provider,
      annual_fee,
      joining_fee,
      extra_fees,
      core_perks,
      secondary_perks,
      extra_perks,
      card_type,
      current_offer,
      product_page,
      old_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      normalizeText(data.card_category),
      normalizeText(data.sub_category),
      normalizeText(data.program),
      normalizeText(data.bank_name),
      normalizeText(data.product),
      parseNumber(data.minimum_salary),
      normalizeText(data.value_metric),
      normalizeText(data.value_calculation),
      normalizeText(data.provider),
      parseNumber(data.annual_fee),
      parseNumber(data.joining_fee),
      normalizeText(data.extra_fees),
      normalizeText(data.core_perks),
      normalizeText(data.secondary_perks),
      normalizeText(data.extra_perks),
      normalizeText(data.card_type),
      normalizeText(data.current_offer),
      normalizeText(data.product_page),
      normalizeText(data.old_notes),
    ]
  );
}

async function getSetting(key) {
  const row = await dbGet("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : "";
}

async function setSetting(key, value) {
  await dbRun("DELETE FROM settings WHERE key = ?", [key]);
  await dbRun("INSERT INTO settings (key, value) VALUES (?, ?)", [key, value]);
}

async function getSettings() {
  const rows = await dbAll("SELECT key, value FROM settings");
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

module.exports = {
  DB_PATH,
  initDb,
  seedFromExcel,
  fetchDistinct,
  getCards,
  insertCard,
  getSetting,
  setSetting,
  getSettings,
  normalizeText,
  parseNumber,
};
