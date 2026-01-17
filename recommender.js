const fetch = global.fetch ? global.fetch.bind(global) : require("node-fetch");

const FEATURE_KEYWORDS = {
  "Cinema Offers": ["cinema", "movie", "vox", "roxy", "reel"],
  "Airport Lounge Access": ["lounge"],
  "Valet Parking": ["valet"],
  "Complementary Golf": ["golf"],
  "Metal Card": ["metal"],
  "Airport Transfers": ["airport transfer", "airport transfers", "careem"],
};

const TRAVEL_KEYWORDS = [
  "flight",
  "flights",
  "hotel",
  "travel",
  "airline",
  "airlines",
  "booking",
  "cleartrip",
  "booking.com",
];

const OTHER_SPEND_KEYWORDS = ["all other", "all other domestic", "other spends", "other spend"];

function detectFeatures(cardText) {
  const matched = [];
  const haystack = (cardText || "").toLowerCase();
  for (const [feature, keywords] of Object.entries(FEATURE_KEYWORDS)) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      matched.push(feature);
    }
  }
  return matched;
}

function extractCashbackRates(text) {
  if (!text) {
    return { travelRate: 0, otherRate: 0, generalRate: 0 };
  }
  let travelRate = 0;
  let otherRate = 0;
  let generalRate = 0;
  const lines = text.toLowerCase().split(/\r?\n/);
  for (const line of lines) {
    const matches = line.match(/(\d+(?:\.\d+)?)\s*%\s*(?:cashback|back)/g);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      const numberMatch = match.match(/\d+(?:\.\d+)?/);
      if (!numberMatch) {
        continue;
      }
      const rate = Number(numberMatch[0]);
      if (Number.isNaN(rate)) {
        continue;
      }
      if (TRAVEL_KEYWORDS.some((keyword) => line.includes(keyword))) {
        travelRate = Math.max(travelRate, rate);
      } else if (OTHER_SPEND_KEYWORDS.some((keyword) => line.includes(keyword))) {
        otherRate = Math.max(otherRate, rate);
      } else {
        generalRate = Math.max(generalRate, rate);
      }
    }
  }
  return { travelRate, otherRate, generalRate };
}

function estimateCashbackValue(category, spend, rates) {
  const totalSpend = Object.values(spend).reduce((sum, value) => sum + value, 0);
  const categoryKey = (category || "").trim().toLowerCase();

  if (categoryKey === "travel") {
    const baseSpend = (spend.travel || 0) + (spend.foreign || 0);
    if (rates.travelRate > 0) {
      return baseSpend * (rates.travelRate / 100);
    }
    if (rates.generalRate > 0) {
      return baseSpend * (rates.generalRate / 100);
    }
    return 0;
  }

  let baseSpend = totalSpend;
  if (categoryKey === "shopping") {
    baseSpend = spend.retail || 0;
  }
  const bestRate = Math.max(rates.travelRate, rates.otherRate, rates.generalRate);
  if (bestRate <= 0) {
    return 0;
  }
  return baseSpend * (bestRate / 100);
}

function scoreCard(card, category, spend, selectedFeatures) {
  const textBlock = [
    card.core_perks,
    card.secondary_perks,
    card.extra_perks,
    card.card_type,
    card.product,
  ]
    .filter(Boolean)
    .join(" ");

  const cashbackRates = extractCashbackRates(textBlock);
  const cashbackValue = estimateCashbackValue(category, spend, cashbackRates);
  const matchedFeatures = new Set(detectFeatures(textBlock));
  const requested = new Set((selectedFeatures || []).map((item) => item.trim()).filter(Boolean));
  const featureHits = Array.from(matchedFeatures).filter((item) => requested.has(item));
  const featureBonus = featureHits.length * 15;

  let score = cashbackValue + featureBonus;
  if (score <= 0) {
    score = (Number(card.minimum_salary) || 0) / 1000 + featureBonus;
  }

  return {
    score,
    cashbackValue,
    matchedFeatures: featureHits,
    availableFeatures: Array.from(matchedFeatures),
  };
}

function truncateText(value, limit = 420) {
  if (!value) {
    return "";
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit) + "...";
}

function buildPrompt(user, cards) {
  const candidates = cards.map((card) => ({
    id: card.id,
    product: card.product,
    bank_name: card.bank_name,
    card_category: card.card_category,
    sub_category: card.sub_category,
    program: card.program,
    minimum_salary: card.minimum_salary,
    annual_fee: card.annual_fee,
    value_metric: card.value_metric,
    value_calculation: card.value_calculation,
    card_type: card.card_type,
    core_perks: truncateText(card.core_perks, 360),
    secondary_perks: truncateText(card.secondary_perks, 240),
    extra_perks: truncateText(card.extra_perks, 240),
  }));

  return [
    "You are a credit card recommendation engine.",
    "Choose the single best card for the user based only on the candidate list provided.",
    "Prioritize monetary value return for the user's spending and honor requested features when possible.",
    "If no card is a valid match, respond with card_id null and explain why.",
    "Return a single-line JSON object only (no markdown, no code fences) with this shape:",
    "{\"card_id\": number|null, \"reason\": \"short reason\"}",
    "Reason must be under 120 characters and contain no line breaks.",
    "User profile:",
    JSON.stringify(user, null, 2),
    "Candidates:",
    JSON.stringify(candidates, null, 2),
  ].join("\n");
}

function sanitizeJsonString(raw) {
  if (!raw) {
    return "";
  }
  let output = "";
  let inString = false;
  let escape = false;
  for (const char of raw) {
    if (escape) {
      output += char;
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      output += char;
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      output += char;
      continue;
    }
    if (inString && (char === "\n" || char === "\r")) {
      output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeJsonText(text) {
  if (!text) {
    return "";
  }
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function salvageJson(text) {
  if (!text) {
    return null;
  }
  const normalized = normalizeJsonText(text);
  const idMatch = normalized.match(/"card_id"\s*:\s*(null|\d+)/i);
  if (!idMatch) {
    return null;
  }
  const rawId = idMatch[1];
  const cardId = rawId.toLowerCase() === "null" ? null : Number(rawId);
  if (cardId !== null && Number.isNaN(cardId)) {
    return null;
  }

  let reason = "";
  const reasonMatch = normalized.match(/"reason"\s*:\s*"([\s\S]*?)"/i);
  if (reasonMatch) {
    reason = reasonMatch[1];
  } else {
    const startMatch = normalized.match(/"reason"\s*:\s*"([\s\S]*)$/i);
    if (startMatch) {
      reason = startMatch[1];
    }
  }
  reason = reason.replace(/```/g, "").replace(/\s+/g, " ").trim();
  return { card_id: cardId, reason };
}

function safeJsonParse(text) {
  if (!text) {
    return null;
  }
  const normalized = normalizeJsonText(text);
  const trimmed = normalized.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return salvageJson(trimmed);
    }
    const candidate = sanitizeJsonString(match[0]);
    try {
      return JSON.parse(candidate);
    } catch (parseErr) {
      return salvageJson(candidate);
    }
  }
}

function parseEarnRules(earnRulesJson) {
  if (!earnRulesJson) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(earnRulesJson);
  } catch (err) {
    return null;
  }
  const rules = Array.isArray(parsed) ? parsed : parsed.earn_rules;
  if (!Array.isArray(rules)) {
    return null;
  }
  let defaultRate = 0;
  const buckets = {};
  for (const rule of rules) {
    if (!rule) {
      continue;
    }
    const bucket = String(rule.bucket || rule.category || "").trim();
    if (!bucket) {
      continue;
    }
    let rate = Number(rule.units_per_aed);
    if (!rate && rule.units_per_x_aed && rule.x_aed) {
      rate = Number(rule.units_per_x_aed) / Number(rule.x_aed);
    }
    if (!rate || Number.isNaN(rate)) {
      continue;
    }
    if (bucket === "default" || bucket === "all") {
      defaultRate = rate;
    } else {
      buckets[bucket] = rate;
    }
  }
  return { buckets, defaultRate };
}

function resolveUnitValue(card) {
  const explicit = Number(card.unit_value_aed || 0);
  if (explicit > 0) {
    return explicit;
  }
  const metric = String(card.reward_unit || card.value_metric || "").toLowerCase();
  if (metric.includes("cashback")) {
    return 1;
  }
  return 0;
}

function computeCardValue(card, spend) {
  const rules = parseEarnRules(card.earn_rules_json);
  if (!rules) {
    return null;
  }
  const unitValue = resolveUnitValue(card);
  if (!unitValue) {
    return null;
  }
  let monthlyUnits = 0;
  for (const [bucket, amount] of Object.entries(spend)) {
    const rate = rules.buckets[bucket] || rules.defaultRate || 0;
    monthlyUnits += Number(amount || 0) * rate;
  }
  const annualUnits = monthlyUnits * 12;
  const annualRewardValue = annualUnits * unitValue;
  const annualFee = Number(card.annual_fee || 0);
  const joiningFee = Number(card.joining_fee || 0);
  const mandatoryFees = Number(card.mandatory_extra_fees_aed || 0);
  const annualFees = annualFee + mandatoryFees;
  const netAnnualValue = annualRewardValue - annualFees;
  const netFirstYearValue = netAnnualValue - joiningFee;

  return {
    annual_units: Number(annualUnits.toFixed(2)),
    unit_value_aed: unitValue,
    annual_reward_value_aed: Number(annualRewardValue.toFixed(2)),
    annual_fees_aed: Number(annualFees.toFixed(2)),
    joining_fee_aed: Number(joiningFee.toFixed(2)),
    net_annual_value_aed: Number(netAnnualValue.toFixed(2)),
    net_first_year_value_aed: Number(netFirstYearValue.toFixed(2)),
  };
}

function pickBestCardDeterministic({ cards, spend, requestedFeatures }) {
  const evaluated = [];
  const skipped = [];
  for (const card of cards) {
    const breakdown = computeCardValue(card, spend);
    if (!breakdown) {
      skipped.push(card);
      continue;
    }
    evaluated.push({ card, breakdown });
  }

  if (!evaluated.length) {
    return {
      card: null,
      reason: "Cards are missing structured earn rules. Upload the Excel template with earn_rules_json filled in.",
    };
  }

  evaluated.sort((a, b) => b.breakdown.net_annual_value_aed - a.breakdown.net_annual_value_aed);
  let winner = evaluated[0];

  if (evaluated.length > 1) {
    const second = evaluated[1];
    const diff = Math.abs(winner.breakdown.net_annual_value_aed - second.breakdown.net_annual_value_aed);
    if (diff <= 200) {
      const requested = new Set((requestedFeatures || []).map((item) => item.toLowerCase()));
      const score = (item) => {
        const text = [item.card.core_perks, item.card.secondary_perks, item.card.extra_perks]
          .filter(Boolean)
          .join(" ");
        const features = detectFeatures(text).map((feature) => feature.toLowerCase());
        return features.filter((feature) => requested.has(feature)).length;
      };
      const winnerScore = score(winner);
      const secondScore = score(second);
      if (secondScore > winnerScore) {
        winner = second;
      } else if (secondScore === winnerScore) {
        const winnerFee = Number(winner.card.annual_fee || 0);
        const secondFee = Number(second.card.annual_fee || 0);
        if (secondFee < winnerFee) {
          winner = second;
        } else if (secondFee === winnerFee) {
          const winnerUnit = resolveUnitValue(winner.card);
          const secondUnit = resolveUnitValue(second.card);
          if (secondUnit > winnerUnit) {
            winner = second;
          }
        }
      }
    }
  }

  return winner;
}

function buildExplanation(card, breakdown) {
  if (!breakdown) {
    return "We could not compute a full value breakdown for this card yet.";
  }
  return `Estimated annual rewards value: AED ${breakdown.annual_reward_value_aed}. Fees deducted: AED ${breakdown.annual_fees_aed}. Net annual value: AED ${breakdown.net_annual_value_aed}.`;
}

async function pickWithGemini({ apiKey, model, user, cards }) {
  if (!apiKey || !model || cards.length === 0) {
    return { error: "AI is not configured or has no candidates." };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: buildPrompt(user, cards) }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: "Could not reach Gemini API." };
  }

  const rawText = await response.text();
  if (!response.ok) {
    return {
      error: `Gemini API error (${response.status}).`,
      details: rawText.slice(0, 400),
    };
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return { error: "Gemini response was not valid JSON.", details: rawText.slice(0, 400) };
  }

  const parts =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts
      ? data.candidates[0].content.parts
      : [];

  const text = parts.map((part) => part.text || "").join("").trim();
  if (!text) {
    return { error: "Gemini response was empty." };
  }

  const parsed = safeJsonParse(text);
  if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, "card_id")) {
    return { error: "Could not parse Gemini output.", details: text.slice(0, 400) };
  }
  return parsed;
}

function selectWithHeuristics({ cards, category, spend, features }) {
  const ranked = cards.map((card) => {
    const scored = scoreCard(card, category, spend, features);
    return { card, scored };
  });

  ranked.sort((a, b) => b.scored.score - a.scored.score);
  return ranked[0] || null;
}

module.exports = {
  scoreCard,
  selectWithHeuristics,
  pickWithGemini,
  detectFeatures,
  pickBestCardDeterministic,
  buildExplanation,
};
