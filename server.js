const express = require("express");
const path = require("path");
const multer = require("multer");
const xlsx = require("xlsx");

const {
  initDb,
  seedFromExcel,
  fetchDistinct,
  getCards,
  replaceCardsFromExcelRows,
  deleteCardById,
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
  res.render("admin", { cards });
});

app.get("/admin/cards/export-excel", async (req, res) => {
  const cards = await getCards({});
  const rows = cards.map((card) => ({
    "Card Category": card.card_category,
    "Sub Category": card.sub_category,
    Program: card.program,
    "Bank Name": card.bank_name,
    Product: card.product,
    "Minimum Salary": card.minimum_salary,
    "Reward Unit": card.reward_unit || card.value_metric || "",
    "Unit Value (AED)": card.unit_value_aed || "",
    "Value Metric": card.value_metric,
    "Value Calculation": card.value_calculation,
    Provider: card.provider,
    "Annual Fee": card.annual_fee,
    "Joining Fee": card.joining_fee,
    "Mandatory Extra Fees (AED)": card.mandatory_extra_fees_aed || "",
    "Extra Fees": card.extra_fees,
    "Core Perks": card.core_perks,
    "Secondary Perks": card.secondary_perks,
    "Extra Perks": card.extra_perks,
    "Card type": card.card_type,
    "Current Offer": card.current_offer,
    "Product Page": card.product_page,
    "Old Notes": card.old_notes,
    "Earn Rules JSON": card.earn_rules_json || "",
  }));

  const headers = [
    "Card Category",
    "Sub Category",
    "Program",
    "Bank Name",
    "Product",
    "Minimum Salary",
    "Reward Unit",
    "Unit Value (AED)",
    "Value Metric",
    "Value Calculation",
    "Provider",
    "Annual Fee",
    "Joining Fee",
    "Mandatory Extra Fees (AED)",
    "Extra Fees",
    "Core Perks",
    "Secondary Perks",
    "Extra Perks",
    "Card type",
    "Current Offer",
    "Product Page",
    "Old Notes",
    "Earn Rules JSON",
  ];

  const worksheet = xlsx.utils.json_to_sheet(rows, { header: headers });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Perkly Card Database");
  const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", "attachment; filename=perkly_cards.xlsx");
  res.send(buffer);
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
  await replaceCardsFromExcelRows(rows);
  res.redirect("/admin");
});

app.post("/admin/cards/delete", async (req, res) => {
  await deleteCardById(req.body.card_id);
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
