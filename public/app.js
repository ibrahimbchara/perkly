const state = {
  category: "",
  subCategory: "",
  program: "",
  income: 0,
  spend: {
    travel: 0,
    retail: 0,
    utilities: 0,
    food_groceries: 0,
    fuel: 0,
    transportation: 0,
    real_estate: 0,
    foreign: 0,
  },
  annualFeeOk: true,
  features: [],
};

const steps = Array.from(document.querySelectorAll(".step"));
const progressBar = document.getElementById("progressBar");
let currentStep = 1;
let historyStack = [];

const categoryOptions = document.getElementById("categoryOptions");
const subcategoryOptions = document.getElementById("subcategoryOptions");
const programOptions = document.getElementById("programOptions");
const resultContainer = document.getElementById("result");

const categoryNext = document.getElementById("categoryNext");
const subcategoryNext = document.getElementById("subcategoryNext");
const programNext = document.getElementById("programNext");
const incomeNext = document.getElementById("incomeNext");
const spendNext = document.getElementById("spendNext");
const extrasNext = document.getElementById("extrasNext");
const restart = document.getElementById("restart");

function showStep(step, pushHistory = true) {
  if (pushHistory && currentStep !== step) {
    historyStack.push(currentStep);
  }
  currentStep = step;
  steps.forEach((element) => {
    element.classList.toggle("active", Number(element.dataset.step) === step);
  });
  const progress = ((step - 1) / (steps.length - 1)) * 100;
  progressBar.style.width = `${progress}%`;
}

function renderOptions(container, items, selected, onSelect) {
  container.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "No options available yet.";
    container.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-btn";
    button.textContent = item;
    if (item === selected) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      onSelect(item);
    });
    container.appendChild(button);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Request failed");
  }
  return response.json();
}

async function loadCategories() {
  const categories = await fetchJson("/api/categories");
  const handleSelect = (value) => {
    state.category = value;
    state.subCategory = "";
    state.program = "";
    subcategoryNext.disabled = true;
    programNext.disabled = true;
    categoryNext.disabled = !value;
    renderOptions(categoryOptions, categories, state.category, handleSelect);
  };
  renderOptions(categoryOptions, categories, state.category, handleSelect);
}

async function loadSubcategories() {
  if (!state.category) {
    return [];
  }
  const subcategories = await fetchJson(`/api/subcategories?category=${encodeURIComponent(state.category)}`);
  const handleSelect = (value) => {
    state.subCategory = value;
    state.program = "";
    programNext.disabled = true;
    subcategoryNext.disabled = !value;
    renderOptions(subcategoryOptions, subcategories, state.subCategory, handleSelect);
  };
  renderOptions(subcategoryOptions, subcategories, state.subCategory, handleSelect);
  return subcategories;
}

async function loadPrograms() {
  if (!state.category || !state.subCategory) {
    return [];
  }
  const programs = await fetchJson(
    `/api/programs?category=${encodeURIComponent(state.category)}&sub_category=${encodeURIComponent(
      state.subCategory
    )}`
  );
  const handleSelect = (value) => {
    state.program = value;
    programNext.disabled = !value;
    renderOptions(programOptions, programs, state.program, handleSelect);
  };
  renderOptions(programOptions, programs, state.program, handleSelect);
  return programs;
}

function resetSelections() {
  state.category = "";
  state.subCategory = "";
  state.program = "";
  state.income = 0;
  state.spend = {
    travel: 0,
    retail: 0,
    utilities: 0,
    food_groceries: 0,
    fuel: 0,
    transportation: 0,
    real_estate: 0,
    foreign: 0,
  };
  state.annualFeeOk = true;
  state.features = [];
  historyStack = [];
  categoryNext.disabled = true;
  subcategoryNext.disabled = true;
  programNext.disabled = true;
  incomeNext.disabled = true;
}

categoryNext.addEventListener("click", async () => {
  const subcategories = await loadSubcategories();
  if (subcategories.length) {
    showStep(2);
  } else {
    state.subCategory = "";
    state.program = "";
    showStep(4);
  }
});

subcategoryNext.addEventListener("click", async () => {
  const programs = await loadPrograms();
  if (programs.length) {
    showStep(3);
  } else {
    state.program = "";
    showStep(4);
  }
});

programNext.addEventListener("click", () => {
  showStep(4);
});

const incomeInput = document.getElementById("income");
if (incomeInput) {
  incomeInput.addEventListener("input", (event) => {
    const value = Number(event.target.value || 0);
    state.income = value;
    incomeNext.disabled = value <= 0;
  });
}

incomeNext.addEventListener("click", () => {
  showStep(5);
});

spendNext.addEventListener("click", () => {
  state.spend.travel = Number(document.getElementById("spendTravel").value || 0);
  state.spend.retail = Number(document.getElementById("spendRetail").value || 0);
  state.spend.utilities = Number(document.getElementById("spendUtilities").value || 0);
  state.spend.food_groceries = Number(document.getElementById("spendFood").value || 0);
  state.spend.fuel = Number(document.getElementById("spendFuel").value || 0);
  state.spend.transportation = Number(document.getElementById("spendTransport").value || 0);
  state.spend.real_estate = Number(document.getElementById("spendRealEstate").value || 0);
  state.spend.foreign = Number(document.getElementById("spendForeign").value || 0);
  showStep(6);
});

extrasNext.addEventListener("click", async () => {
  const annualFeeSelection = document.querySelector("input[name='annualFee']:checked");
  state.annualFeeOk = annualFeeSelection ? annualFeeSelection.value === "yes" : true;

  const selectedFeatures = Array.from(document.querySelectorAll("#featureOptions input:checked")).map(
    (input) => input.value
  );
  state.features = selectedFeatures;

  showStep(7);
  await fetchRecommendation();
});

function renderAnalyzing() {
  resultContainer.innerHTML = "";
  const card = document.createElement("div");
  card.className = "result-card analyzing";
  const title = document.createElement("div");
  title.className = "result-title";
  title.textContent = "Analyzing your profile";
  const body = document.createElement("p");
  body.className = "result-meta";
  body.textContent = "Our AI is comparing every eligible card in real time.";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(spinner);
  resultContainer.appendChild(card);
}

function renderResultEmpty(message) {
  resultContainer.innerHTML = "";
  const card = document.createElement("div");
  card.className = "result-card";
  const title = document.createElement("div");
  title.className = "result-title";
  title.textContent = "No card available";
  const body = document.createElement("p");
  body.className = "result-meta";
  body.textContent = message;
  card.appendChild(title);
  card.appendChild(body);
  resultContainer.appendChild(card);
}

function renderResult(cardData) {
  resultContainer.innerHTML = "";
  if (!cardData || !cardData.card) {
    renderResultEmpty(cardData && cardData.reason ? cardData.reason : "We could not find a match yet.");
    return;
  }

  const card = cardData.card;
  const wrapper = document.createElement("div");
  wrapper.className = "result-card";

  const header = document.createElement("div");
  header.className = "result-header";

  const title = document.createElement("div");
  title.className = "result-title";
  title.textContent = card.product || "Recommended Card";

  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.textContent = `${card.bank_name || ""} - ${card.card_type || ""}`.replace(/\s+-\s+$/, "");

  header.appendChild(title);
  header.appendChild(meta);

  const badges = document.createElement("div");
  badges.className = "result-meta";
  badges.textContent = `Minimum Salary: AED ${card.minimum_salary || 0} - Annual Fee: AED ${card.annual_fee || 0}`;

  const perks = document.createElement("div");
  perks.className = "result-meta";
  const perksText = (card.core_perks || "").split("\n").slice(0, 3).join(" ");
  perks.textContent = perksText || "Core benefits listed with the card.";

  const highlight = document.createElement("div");
  highlight.className = "result-meta";
  if (cardData.breakdown) {
    highlight.textContent = `Net annual value: AED ${cardData.breakdown.net_annual_value_aed} (fees AED ${cardData.breakdown.annual_fees_aed}).`;
  } else {
    highlight.textContent = cardData.explanation || "We picked the best value card based on your spend.";
  }

  const explanation = document.createElement("div");
  explanation.className = "result-meta";
  explanation.textContent = cardData.explanation || "";

  const actions = document.createElement("div");
  actions.className = "result-actions";
  if (card.product_page) {
    const link = document.createElement("a");
    link.href = card.product_page;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Apply on bank site";
    actions.appendChild(link);
  }

  wrapper.appendChild(header);
  wrapper.appendChild(badges);
  wrapper.appendChild(perks);
  wrapper.appendChild(highlight);
  if (cardData.explanation) {
    wrapper.appendChild(explanation);
  }
  if (actions.children.length) {
    wrapper.appendChild(actions);
  }

  resultContainer.appendChild(wrapper);
}

async function fetchRecommendation() {
  renderAnalyzing();
  try {
    const response = await fetch("/api/recommend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: state.category,
        sub_category: state.subCategory,
        program: state.program,
        income: state.income,
        spend: state.spend,
        annual_fee_ok: state.annualFeeOk,
        features: state.features,
      }),
    });
    const data = await response.json();
    renderResult(data);
  } catch (error) {
    renderResultEmpty("We hit a hiccup while loading your result.");
  }
}

const featureInputs = Array.from(document.querySelectorAll("#featureOptions input"));
featureInputs.forEach((input) => {
  input.addEventListener("change", (event) => {
    const selected = featureInputs.filter((item) => item.checked);
    if (selected.length > 2) {
      event.target.checked = false;
    }
  });
});

const backButtons = Array.from(document.querySelectorAll("[data-back]"));
backButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const previous = historyStack.pop() || 1;
    showStep(previous, false);
  });
});

restart.addEventListener("click", () => {
  resetSelections();
  loadCategories();
  showStep(1, false);
});

resetSelections();
loadCategories();
showStep(1, false);
