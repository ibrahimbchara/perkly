const express = require("express");
const path = require("path");

const {
  initDb,
  seedFromExcel,
  fetchDistinct,
  getCards,
  insertCard,
  getSettings,
  setSetting,
  updateCardCalculationFields,
} = require("./db");
const { pickBestCardDeterministic, buildExplanation } = require("./recommender");

const app = express();
const PORT = process.env.PORT || 3000;

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
