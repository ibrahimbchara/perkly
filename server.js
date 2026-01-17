const express = require("express");
const path = require("path");
const multer = require("multer");
const xlsx = require("xlsx");

const {
  initDb,
  seedFromExcel,
  fetchDistinct,
  getCards,
  insertCard,
  getSettings,
  setSetting,
  updateCardCalculationFields,
  updateCardsCalculationByFilter,
} = require("./db");
const { pickBestCardDeterministic, buildExplanation } = require("./recommender");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

async function boot() {
  await initDb();
  await seedFromExcel();
}

app.get("/", (req, res) => {
  res.render("index");
});

app.get("/admin", async (req, res) => {
  const cards = await getCards({});
  const settings = await getSettings();
  res.render("admin", {
    cards,
    settings: {
      gemini_api_key: settings.gemini_api_key || "",
      gemini_model: settings.gemini_model || "",
    },
  });
});

app.post("/admin/cards", async (req, res) => {
  await insertCard(req.body);
  res.redirect("/admin");
});

app.post("/admin/cards/update", async (req, res) => {
  await updateCardCalculationFields(req.body);
  res.redirect("/admin");
});

app.post("/admin/cards/rules", async (req, res) => {
  const cardId = (req.body.card_id || "").trim();
  const filters = {
    card_category: (req.body.card_category || "").trim(),
    sub_category: (req.body.sub_category || "").trim(),
    program: (req.body.program || "").trim(),
  };
  const rewardUnit = (req.body.reward_unit || "").trim();
  const unitValue = req.body.unit_value_aed;
  const mandatoryExtra = req.body.mandatory_extra_fees_aed;

  const buckets = [
    "default",
    "travel",
    "retail",
    "utilities",
    "food_groceries",
    "fuel",
    "transportation",
    "real_estate",
    "foreign",
  ];
  const rules = [];
  for (const bucket of buckets) {
    const value = req.body[`rate_${bucket}`];
    if (value === undefined || String(value).trim() === "") {
      continue;
    }
    const rate = Number(value);
    if (!Number.isNaN(rate) && rate > 0) {
      rules.push({ bucket, units_per_aed: rate });
    }
  }

  const payload = {
    reward_unit: rewardUnit,
    unit_value_aed: unitValue,
    mandatory_extra_fees_aed: mandatoryExtra,
    earn_rules_json: rules.length ? JSON.stringify(rules) : "",
  };

  if (cardId) {
    await updateCardCalculationFields({ ...payload, card_id: cardId });
  } else {
    await updateCardsCalculationByFilter(filters, payload);
  }

  res.redirect("/admin");
});

app.get("/admin/cards/export", async (req, res) => {
  const cards = await getCards({});
  const rows = cards.map((card) => ({
    card_id: card.id,
    card_category: card.card_category,
    sub_category: card.sub_category,
    program: card.program,
    bank_name: card.bank_name,
    product: card.product,
    reward_unit: card.reward_unit || card.value_metric || "",
    unit_value_aed: card.unit_value_aed || "",
    mandatory_extra_fees_aed: card.mandatory_extra_fees_aed || "",
    earn_rules_json: card.earn_rules_json || "",
  }));

  const headers = [
    "card_id",
    "card_category",
    "sub_category",
    "program",
    "bank_name",
    "product",
    "reward_unit",
    "unit_value_aed",
    "mandatory_extra_fees_aed",
    "earn_rules_json",
  ];

  const worksheet = xlsx.utils.json_to_sheet(rows, { header: headers });
  const csv = xlsx.utils.sheet_to_csv(worksheet);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=perkly_calculation_fields.csv");
  res.send(csv);
});

app.post("/admin/cards/import", upload.single("cards_csv"), async (req, res) => {
  if (!req.file) {
    res.redirect("/admin");
    return;
  }
  const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  for (const row of rows) {
    const cardId = row.card_id || row.id;
    if (!cardId) {
      continue;
    }
    await updateCardCalculationFields({
      card_id: cardId,
      reward_unit: row.reward_unit,
      unit_value_aed: row.unit_value_aed,
      mandatory_extra_fees_aed: row.mandatory_extra_fees_aed,
      earn_rules_json: row.earn_rules_json,
    });
  }

  res.redirect("/admin");
});

app.post("/admin/cards/import-excel", upload.single("cards_excel"), async (req, res) => {
  if (!req.file) {
    res.redirect("/admin");
    return;
  }
  const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const cards = await getCards({});
  const map = new Map();
  for (const card of cards) {
    const key = `${(card.bank_name || "").toLowerCase()}|${(card.product || "").toLowerCase()}|${(card.program || "").toLowerCase()}|${(card.sub_category || "").toLowerCase()}`;
    map.set(key, card.id);
  }

  for (const row of rows) {
    const cardId = row.card_id || row.id;
    let targetId = cardId;
    if (!targetId) {
      const key = `${String(row["Bank Name"] || row.bank_name || "").toLowerCase()}|${String(
        row["Product"] || row.product || ""
      ).toLowerCase()}|${String(row["Program"] || row.program || "").toLowerCase()}|${String(
        row["Sub Category"] || row.sub_category || ""
      ).toLowerCase()}`;
      targetId = map.get(key);
    }
    if (!targetId) {
      continue;
    }
    await updateCardCalculationFields({
      card_id: targetId,
      reward_unit: row.reward_unit || row["Reward Unit"],
      unit_value_aed: row.unit_value_aed || row["Unit Value (AED)"] || row["Unit Value"],
      mandatory_extra_fees_aed: row.mandatory_extra_fees_aed || row["Mandatory Extra Fees (AED)"],
      earn_rules_json: row.earn_rules_json || row["Earn Rules JSON"],
    });
  }

  res.redirect("/admin");
});

app.post("/admin/settings", async (req, res) => {
  const apiKey = (req.body.gemini_api_key || "").trim();
  const model = (req.body.gemini_model || "").trim();

  if (apiKey) {
    await setSetting("gemini_api_key", apiKey);
  }
  if (model) {
    await setSetting("gemini_model", model);
  }

  res.redirect("/admin");
});

app.get("/api/categories", async (req, res) => {
  const categories = await fetchDistinct("card_category");
  res.json(categories);
});

app.get("/api/subcategories", async (req, res) => {
  const category = (req.query.category || "").trim();
  const subcategories = await fetchDistinct("sub_category", { card_category: category });
  res.json(subcategories);
});

app.get("/api/programs", async (req, res) => {
  const category = (req.query.category || "").trim();
  const subCategory = (req.query.sub_category || "").trim();
  const programs = await fetchDistinct("program", {
    card_category: category,
    sub_category: subCategory,
  });
  res.json(programs);
});

app.post("/api/recommend", async (req, res) => {
  const category = (req.body.category || "").trim();
  const subCategory = (req.body.sub_category || "").trim();
  const program = (req.body.program || "").trim();
  const income = Number(req.body.income || 0);
  const annualFeeOk = req.body.annual_fee_ok !== false;
  const spend = req.body.spend || {};
  const features = Array.isArray(req.body.features) ? req.body.features : [];

  const spendValues = {
    travel: Number(spend.travel || 0),
    retail: Number(spend.retail || 0),
    utilities: Number(spend.utilities || 0),
    food_groceries: Number(spend.food_groceries || 0),
    fuel: Number(spend.fuel || 0),
    transportation: Number(spend.transportation || 0),
    real_estate: Number(spend.real_estate || 0),
    foreign: Number(spend.foreign || 0),
  };

  const cards = await getCards({
    card_category: category,
    sub_category: subCategory,
    program: program,
  });

  if (!cards.length) {
    res.json({ card: null, reason: "No cards match that category or partner yet." });
    return;
  }

  const eligible = cards.filter((card) => {
    if (income && card.minimum_salary && income < Number(card.minimum_salary)) {
      return false;
    }
    if (!annualFeeOk && card.annual_fee && Number(card.annual_fee) > 0) {
      return false;
    }
    return true;
  });

  if (!eligible.length) {
    res.json({ card: null, reason: "No cards match your income or annual fee preference." });
    return;
  }

  const result = pickBestCardDeterministic({
    cards: eligible,
    spend: spendValues,
    requestedFeatures: features,
  });

  if (!result || !result.card) {
    res.json({ card: null, reason: result && result.reason ? result.reason : "No card matches your criteria." });
    return;
  }

  const card = result.card;
  const breakdown = result.breakdown;

  res.json({
    card: {
      id: card.id,
      card_category: card.card_category,
      sub_category: card.sub_category,
      program: card.program,
      bank_name: card.bank_name,
      product: card.product,
      minimum_salary: card.minimum_salary,
      annual_fee: card.annual_fee,
      value_metric: card.value_metric,
      value_calculation: card.value_calculation,
      core_perks: card.core_perks,
      secondary_perks: card.secondary_perks,
      extra_perks: card.extra_perks,
      card_type: card.card_type,
      current_offer: card.current_offer,
      product_page: card.product_page,
    },
    breakdown,
    explanation: buildExplanation(card, breakdown),
  });
});

boot()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Perkly running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize:", err);
  });
