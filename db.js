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
  await backfillCalculationFields();
  await autoFillEarnRules();
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

async function backfillCalculationFields() {
  const cards = await dbAll(
    "SELECT id, reward_unit, unit_value_aed, value_metric, value_calculation, extra_fees, mandatory_extra_fees_aed FROM cards"
  );
  for (const card of cards) {
    const rewardUnit = normalizeText(card.reward_unit) || normalizeText(card.value_metric);
    const unitValue = Number(card.unit_value_aed || 0) || parseUnitValue(card.value_calculation, card.value_metric);
    const extraFees = Number(card.mandatory_extra_fees_aed || 0) || parseNumber(card.extra_fees);

    if (
      rewardUnit !== (card.reward_unit || "") ||
      unitValue !== Number(card.unit_value_aed || 0) ||
      extraFees !== Number(card.mandatory_extra_fees_aed || 0)
    ) {
      await dbRun(
        `UPDATE cards
         SET reward_unit = ?,
             unit_value_aed = ?,
             mandatory_extra_fees_aed = ?
         WHERE id = ?`,
        [rewardUnit, unitValue, extraFees, card.id]
      );
    }
  }
}

function detectBucketsFromLine(line) {
  const text = line.toLowerCase();
  const buckets = new Set();
  const addIf = (bucket, keywords) => {
    if (keywords.some((keyword) => text.includes(keyword))) {
      buckets.add(bucket);
    }
  };

  addIf("travel", ["flight", "flights", "airline", "emirates", "etihad", "hotel", "travel", "emirates.com"]);
  addIf("food_groceries", ["grocery", "groceries", "supermarket", "food", "restaurant", "qsr", "dining"]);
  addIf("utilities", ["utilities", "telecommunication", "telecom"]);
  addIf("fuel", ["fuel", "petroleum"]);
  addIf("government", ["government"]);
  addIf("real_estate", ["real estate"]);
  addIf("transportation", ["transportation", "transport"]);
  addIf("retail", ["retail", "online", "shopping"]);
  addIf("foreign", ["foreign", "international", "usd", "overseas"]);

  return Array.from(buckets);
}

function parseRateFromLine(line) {
  const text = line.toLowerCase();
  const cashbackMatch = text.match(/(\d+(?:\.\d+)?)\s*%[^\\n]*cashback|(\d+(?:\.\d+)?)\s*%[^\\n]*back/);
  if (cashbackMatch) {
    const pct = Number(cashbackMatch[1] || cashbackMatch[2]);
    if (!Number.isNaN(pct)) {
      return pct / 100;
    }
  }

  const perAedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:[a-z\\s]+)?per\\s*aed\\s*([0-9.]+)?/);
  if (perAedMatch) {
    const units = Number(perAedMatch[1]);
    const denom = perAedMatch[2] ? Number(perAedMatch[2]) : 1;
    if (!Number.isNaN(units) && !Number.isNaN(denom) && denom > 0) {
      return units / denom;
    }
  }

  const perUsdMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:[a-z\\s]+)?per\\s*usd/);
  if (perUsdMatch) {
    const units = Number(perUsdMatch[1]);
    if (!Number.isNaN(units)) {
      return units / 3.67;
    }
  }

  return 0;
}

async function autoFillEarnRules() {
  const rows = await dbAll(
    "SELECT id, earn_rules_json, core_perks, secondary_perks, extra_perks, value_metric FROM cards"
  );
  for (const card of rows) {
    if (normalizeText(card.earn_rules_json)) {
      continue;
    }
    const combined = [card.core_perks, card.secondary_perks, card.extra_perks]
      .filter(Boolean)
      .join("\n");
    const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let defaultRate = 0;
    const bucketRates = {};
    for (const line of lines) {
      const rate = parseRateFromLine(line);
      if (!rate) {
        continue;
      }
      const buckets = detectBucketsFromLine(line);
      if (!buckets.length) {
        defaultRate = Math.max(defaultRate, rate);
      } else {
        for (const bucket of buckets) {
          bucketRates[bucket] = Math.max(bucketRates[bucket] || 0, rate);
        }
      }
    }
    if (!defaultRate && Object.keys(bucketRates).length) {
      defaultRate = Math.max(...Object.values(bucketRates));
    }
    if (!defaultRate && !Object.keys(bucketRates).length) {
      continue;
    }
    const rules = [];
    if (defaultRate) {
      rules.push({ bucket: "default", units_per_aed: Number(defaultRate.toFixed(6)) });
    }
    for (const [bucket, rate] of Object.entries(bucketRates)) {
      rules.push({ bucket, units_per_aed: Number(rate.toFixed(6)) });
    }
    await dbRun("UPDATE cards SET earn_rules_json = ? WHERE id = ?", [JSON.stringify(rules), card.id]);
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
  const existing = await dbGet(
    "SELECT reward_unit, unit_value_aed, mandatory_extra_fees_aed, earn_rules_json FROM cards WHERE id = ?",
    [cardId]
  );
  if (!existing) {
    return;
  }

  const rewardUnit = normalizeText(data.reward_unit) || existing.reward_unit || "";
  const unitValue =
    data.unit_value_aed !== undefined && String(data.unit_value_aed).trim() !== ""
      ? parseNumber(data.unit_value_aed)
      : Number(existing.unit_value_aed || 0);
  const mandatoryExtra =
    data.mandatory_extra_fees_aed !== undefined && String(data.mandatory_extra_fees_aed).trim() !== ""
      ? parseNumber(data.mandatory_extra_fees_aed)
      : Number(existing.mandatory_extra_fees_aed || 0);
  const earnRules = normalizeText(data.earn_rules_json) || existing.earn_rules_json || "";

  await dbRun(
    `UPDATE cards
     SET reward_unit = ?,
         unit_value_aed = ?,
         mandatory_extra_fees_aed = ?,
         earn_rules_json = ?
     WHERE id = ?`,
    [rewardUnit, unitValue, mandatoryExtra, earnRules, cardId]
  );
}

async function updateCardsCalculationByFilter(filters, data) {
  let query = "SELECT id FROM cards WHERE 1=1";
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value) {
      continue;
    }
    query += ` AND ${key} = ?`;
    params.push(value);
  }
  const rows = await dbAll(query, params);
  for (const row of rows) {
    await updateCardCalculationFields({ ...data, card_id: row.id });
  }
  return rows.length;
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
  updateCardsCalculationByFilter,
  getSetting,
  setSetting,
  getSettings,
  normalizeText,
  parseNumber,
};
