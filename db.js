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

function parseUnitValue(value, metric) {
  const fromValue = parseNumber(value);
  if (fromValue > 0) {
    return fromValue;
  }
  const metricText = normalizeText(metric).toLowerCase();
  if (metricText.includes("cashback")) {
    return 1;
  }
  return 0;
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
      reward_unit TEXT,
      unit_value_aed REAL,
      value_metric TEXT,
      value_calculation TEXT,
      provider TEXT,
      annual_fee REAL,
      joining_fee REAL,
      mandatory_extra_fees_aed REAL,
      extra_fees TEXT,
      core_perks TEXT,
      secondary_perks TEXT,
      extra_perks TEXT,
      card_type TEXT,
      current_offer TEXT,
      product_page TEXT,
      old_notes TEXT,
      earn_rules_json TEXT
    )`
  );
  await ensureColumns();
  await dbRun(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  );
}

async function ensureColumns() {
  const columns = await dbAll("PRAGMA table_info(cards)");
  const existing = new Set(columns.map((col) => col.name));
  const toAdd = [
    { name: "reward_unit", type: "TEXT" },
    { name: "unit_value_aed", type: "REAL" },
    { name: "mandatory_extra_fees_aed", type: "REAL" },
    { name: "earn_rules_json", type: "TEXT" },
  ];
  for (const column of toAdd) {
    if (!existing.has(column.name)) {
      await dbRun(`ALTER TABLE cards ADD COLUMN ${column.name} ${column.type}`);
    }
  }
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

    const valueMetric = normalizeText(entry["Value Metric"]);
    const valueCalculation = normalizeText(entry["Value Calculation"]);

    await dbRun(
      `INSERT INTO cards (
        card_category,
        sub_category,
        program,
        bank_name,
        product,
        minimum_salary,
        reward_unit,
        unit_value_aed,
        value_metric,
        value_calculation,
        provider,
        annual_fee,
        joining_fee,
        mandatory_extra_fees_aed,
        extra_fees,
        core_perks,
        secondary_perks,
        extra_perks,
        card_type,
        current_offer,
        product_page,
        old_notes,
        earn_rules_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        cardCategory,
        subCategory,
        normalizeText(entry["Program"]),
        normalizeText(entry["Bank Name"]),
        normalizeText(entry["Product"]),
        parseNumber(entry["Minimum Salary"]),
        valueMetric,
        parseUnitValue(valueCalculation, valueMetric),
        valueMetric,
        valueCalculation,
        normalizeText(entry["Provider"]),
        parseNumber(entry["Annual Fee"]),
        parseNumber(entry["Joining Fee"]),
        parseNumber(entry["Extra Fees"]),
        normalizeText(entry["Extra Fees"]),
        normalizeText(entry["Core Perks"]),
        normalizeText(entry["Secondary Perks"]),
        normalizeText(entry["Extra Perks"]),
        normalizeText(entry["Card type"]),
        normalizeText(entry["Current Offer"]),
        normalizeText(entry["Product Page"]),
        normalizeText(entry["Old Notes"]),
        "",
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
      reward_unit,
      unit_value_aed,
      value_metric,
      value_calculation,
      provider,
      annual_fee,
      joining_fee,
      mandatory_extra_fees_aed,
      extra_fees,
      core_perks,
      secondary_perks,
      extra_perks,
      card_type,
      current_offer,
      product_page,
      old_notes,
      earn_rules_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      normalizeText(data.card_category),
      normalizeText(data.sub_category),
      normalizeText(data.program),
      normalizeText(data.bank_name),
      normalizeText(data.product),
      parseNumber(data.minimum_salary),
      normalizeText(data.reward_unit),
      parseNumber(data.unit_value_aed),
      normalizeText(data.value_metric),
      normalizeText(data.value_calculation),
      normalizeText(data.provider),
      parseNumber(data.annual_fee),
      parseNumber(data.joining_fee),
      parseNumber(data.mandatory_extra_fees_aed),
      normalizeText(data.extra_fees),
      normalizeText(data.core_perks),
      normalizeText(data.secondary_perks),
      normalizeText(data.extra_perks),
      normalizeText(data.card_type),
      normalizeText(data.current_offer),
      normalizeText(data.product_page),
      normalizeText(data.old_notes),
      normalizeText(data.earn_rules_json),
    ]
  );
}

async function updateCardCalculationFields(data) {
  const cardId = Number(data.card_id || 0);
  if (!cardId) {
    return;
  }
  await dbRun(
    `UPDATE cards
     SET reward_unit = ?,
         unit_value_aed = ?,
         mandatory_extra_fees_aed = ?,
         earn_rules_json = ?
     WHERE id = ?`,
    [
      normalizeText(data.reward_unit),
      parseNumber(data.unit_value_aed),
      parseNumber(data.mandatory_extra_fees_aed),
      normalizeText(data.earn_rules_json),
      cardId,
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
  updateCardCalculationFields,
  getSetting,
  setSetting,
  getSettings,
  normalizeText,
  parseNumber,
};
