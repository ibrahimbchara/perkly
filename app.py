from __future__ import annotations

import os
import re
import sqlite3
from typing import Dict, List, Tuple

import pandas as pd
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_DIR, "data", "cards.db")
EXCEL_PATH = os.path.join(APP_DIR, "Bank Cards V2.1 - Travel Sample.xlsx")

FEATURE_KEYWORDS = {
    "Cinema Offers": ["cinema", "movie", "vox", "roxy", "reel"],
    "Airport Lounge Access": ["lounge"],
    "Valet Parking": ["valet"],
    "Complementary Golf": ["golf"],
    "Metal Card": ["metal"],
    "Airport Transfers": ["airport transfer", "airport transfers", "careem"],
}

TRAVEL_KEYWORDS = [
    "flight",
    "flights",
    "hotel",
    "travel",
    "airline",
    "airlines",
    "booking",
    "cleartrip",
    "booking.com",
]

OTHER_SPEND_KEYWORDS = ["all other", "all other domestic", "other spends", "other spend"]


app = FastAPI(title="Perkly 2.0")
app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(APP_DIR, "templates"))


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def parse_number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)) and not pd.isna(value):
        return float(value)
    text = str(value)
    text = re.sub(r"[^0-9.]", "", text)
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def normalize_text(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "0"}:
        return ""
    return text


def init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cards (
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
        )
        """
    )
    conn.commit()
    conn.close()


def seed_from_excel() -> None:
    if not os.path.exists(EXCEL_PATH):
        return

    conn = get_db_connection()
    existing = conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    if existing:
        conn.close()
        return

    df = pd.read_excel(EXCEL_PATH)
    df = df.dropna(how="all")
    if "Card Category" in df.columns:
        df = df[df["Card Category"].notna()]
        df = df[df["Card Category"].astype(str).str.strip().ne("Card Category")]
    if "Sub Category" in df.columns:
        df = df[df["Sub Category"].astype(str).str.strip().ne("Sub Category")]
    df = df.fillna("")

    rows = []
    for _, row in df.iterrows():
        rows.append(
            (
                normalize_text(row.get("Card Category")),
                normalize_text(row.get("Sub Category")),
                normalize_text(row.get("Program")),
                normalize_text(row.get("Bank Name")),
                normalize_text(row.get("Product")),
                parse_number(row.get("Minimum Salary")),
                normalize_text(row.get("Value Metric")),
                normalize_text(row.get("Value Calculation")),
                normalize_text(row.get("Provider")),
                parse_number(row.get("Annual Fee")),
                parse_number(row.get("Joining Fee")),
                normalize_text(row.get("Extra Fees")),
                normalize_text(row.get("Core Perks")),
                normalize_text(row.get("Secondary Perks")),
                normalize_text(row.get("Extra Perks")),
                normalize_text(row.get("Card type")),
                normalize_text(row.get("Current Offer")),
                normalize_text(row.get("Product Page")),
                normalize_text(row.get("Old Notes")),
            )
        )

    conn.executemany(
        """
        INSERT INTO cards (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    conn.close()


def extract_cashback_rates(text: str) -> Tuple[float, float, float]:
    if not text:
        return 0.0, 0.0, 0.0
    travel_rate = 0.0
    other_rate = 0.0
    general_rate = 0.0
    lines = re.split(r"[\n\r]+", text.lower())
    for line in lines:
        for match in re.finditer(r"(\d+(?:\.\d+)?)\s*%\s*(?:cashback|back)", line):
            rate = float(match.group(1))
            if any(keyword in line for keyword in TRAVEL_KEYWORDS):
                travel_rate = max(travel_rate, rate)
            elif any(keyword in line for keyword in OTHER_SPEND_KEYWORDS):
                other_rate = max(other_rate, rate)
            else:
                general_rate = max(general_rate, rate)
    return travel_rate, other_rate, general_rate


def detect_features(card_text: str) -> List[str]:
    matched = []
    haystack = card_text.lower()
    for feature, keywords in FEATURE_KEYWORDS.items():
        if any(keyword in haystack for keyword in keywords):
            matched.append(feature)
    return matched


def estimate_cashback_value(category: str, spend: Dict[str, float], rates: Tuple[float, float, float]) -> float:
    travel_rate, other_rate, general_rate = rates
    total_spend = sum(spend.values())
    category_key = (category or "").strip().lower()

    if category_key == "travel":
        base_spend = spend.get("travel", 0.0) + spend.get("foreign", 0.0)
        if travel_rate > 0:
            return base_spend * (travel_rate / 100.0)
        if general_rate > 0:
            return base_spend * (general_rate / 100.0)
        return 0.0

    if category_key == "shopping":
        base_spend = spend.get("retail", 0.0)
    elif category_key in {"cashback", "rewards"}:
        base_spend = total_spend
    else:
        base_spend = total_spend

    best_rate = max(travel_rate, other_rate, general_rate)
    if best_rate <= 0:
        return 0.0
    return base_spend * (best_rate / 100.0)


def score_card(card: sqlite3.Row, category: str, spend: Dict[str, float], selected_features: List[str]) -> Dict:
    text_block = " ".join(
        [
            card["core_perks"] or "",
            card["secondary_perks"] or "",
            card["extra_perks"] or "",
            card["card_type"] or "",
            card["product"] or "",
        ]
    )
    cashback_rates = extract_cashback_rates(text_block)
    cashback_value = estimate_cashback_value(category, spend, cashback_rates)
    matched_features = set(detect_features(text_block))
    requested_features = set([feature.strip() for feature in selected_features if feature])
    feature_hits = matched_features.intersection(requested_features)
    feature_bonus = len(feature_hits) * 15.0

    if cashback_value > 0:
        score = cashback_value + feature_bonus
    else:
        tier_score = (card["minimum_salary"] or 0.0) / 1000.0
        score = tier_score + feature_bonus

    return {
        "score": score,
        "cashback_value": cashback_value,
        "matched_features": sorted(feature_hits),
        "available_features": sorted(matched_features),
    }


def fetch_distinct(column: str, filters: Dict[str, str] | None = None) -> List[str]:
    filters = filters or {}
    conn = get_db_connection()
    query = f"SELECT DISTINCT {column} FROM cards WHERE {column} != ''"
    params: List[str] = []
    for key, value in filters.items():
        query += f" AND {key} = ?"
        params.append(value)
    query += f" ORDER BY {column}"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [row[0] for row in rows if row[0]]


def fetch_cards(filters: Dict[str, str]) -> List[sqlite3.Row]:
    conn = get_db_connection()
    query = "SELECT * FROM cards WHERE 1=1"
    params: List[str] = []
    for key, value in filters.items():
        if value:
            query += f" AND {key} = ?"
            params.append(value)
    query += " ORDER BY product"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return rows


@app.on_event("startup")
def startup_event() -> None:
    init_db()
    seed_from_excel()


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/admin", response_class=HTMLResponse)
def admin(request: Request):
    cards = fetch_cards({})
    return templates.TemplateResponse("admin.html", {"request": request, "cards": cards})


@app.post("/admin/cards")
def admin_add_card(
    card_category: str = Form(""),
    sub_category: str = Form(""),
    program: str = Form(""),
    bank_name: str = Form(""),
    product: str = Form(""),
    minimum_salary: str = Form(""),
    value_metric: str = Form(""),
    value_calculation: str = Form(""),
    provider: str = Form(""),
    annual_fee: str = Form(""),
    joining_fee: str = Form(""),
    extra_fees: str = Form(""),
    core_perks: str = Form(""),
    secondary_perks: str = Form(""),
    extra_perks: str = Form(""),
    card_type: str = Form(""),
    current_offer: str = Form(""),
    product_page: str = Form(""),
    old_notes: str = Form(""),
):
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO cards (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            normalize_text(card_category),
            normalize_text(sub_category),
            normalize_text(program),
            normalize_text(bank_name),
            normalize_text(product),
            parse_number(minimum_salary),
            normalize_text(value_metric),
            normalize_text(value_calculation),
            normalize_text(provider),
            parse_number(annual_fee),
            parse_number(joining_fee),
            normalize_text(extra_fees),
            normalize_text(core_perks),
            normalize_text(secondary_perks),
            normalize_text(extra_perks),
            normalize_text(card_type),
            normalize_text(current_offer),
            normalize_text(product_page),
            normalize_text(old_notes),
        ),
    )
    conn.commit()
    conn.close()
    return RedirectResponse(url="/admin", status_code=303)


@app.get("/api/categories", response_class=JSONResponse)
def api_categories():
    return fetch_distinct("card_category")


@app.get("/api/subcategories", response_class=JSONResponse)
def api_subcategories(category: str):
    return fetch_distinct("sub_category", {"card_category": category})


@app.get("/api/programs", response_class=JSONResponse)
def api_programs(category: str, sub_category: str):
    return fetch_distinct(
        "program",
        {"card_category": category, "sub_category": sub_category},
    )


@app.post("/api/recommend", response_class=JSONResponse)
def api_recommend(payload: Dict):
    category = payload.get("category", "").strip()
    sub_category = payload.get("sub_category", "").strip()
    program = payload.get("program", "").strip()
    income = float(payload.get("income") or 0)
    annual_fee_ok = bool(payload.get("annual_fee_ok", True))
    spend = payload.get("spend") or {}
    selected_features = payload.get("features") or []

    spend_values = {
        "travel": float(spend.get("travel") or 0),
        "retail": float(spend.get("retail") or 0),
        "utilities": float(spend.get("utilities") or 0),
        "food_groceries": float(spend.get("food_groceries") or 0),
        "fuel": float(spend.get("fuel") or 0),
        "transportation": float(spend.get("transportation") or 0),
        "real_estate": float(spend.get("real_estate") or 0),
        "foreign": float(spend.get("foreign") or 0),
    }

    filters = {"card_category": category, "sub_category": sub_category, "program": program}
    cards = fetch_cards(filters)
    if not cards:
        return {"card": None, "reason": "No cards match that category or partner yet."}

    eligible = []
    for card in cards:
        if income and card["minimum_salary"] and income < card["minimum_salary"]:
            continue
        if not annual_fee_ok and card["annual_fee"] and card["annual_fee"] > 0:
            continue
        eligible.append(card)

    if not eligible:
        reason = "No cards match your income or annual fee preference."
        return {"card": None, "reason": reason}

    ranked = []
    for card in eligible:
        scored = score_card(card, category, spend_values, selected_features)
        ranked.append((scored["score"], scored, card))

    ranked.sort(key=lambda item: item[0], reverse=True)
    best_score, best_meta, best_card = ranked[0]

    response = {
        "card": {
            "id": best_card["id"],
            "card_category": best_card["card_category"],
            "sub_category": best_card["sub_category"],
            "program": best_card["program"],
            "bank_name": best_card["bank_name"],
            "product": best_card["product"],
            "minimum_salary": best_card["minimum_salary"],
            "annual_fee": best_card["annual_fee"],
            "value_metric": best_card["value_metric"],
            "value_calculation": best_card["value_calculation"],
            "core_perks": best_card["core_perks"],
            "secondary_perks": best_card["secondary_perks"],
            "extra_perks": best_card["extra_perks"],
            "card_type": best_card["card_type"],
            "current_offer": best_card["current_offer"],
            "product_page": best_card["product_page"],
        },
        "score": best_score,
        "cashback_value": best_meta["cashback_value"],
        "matched_features": best_meta["matched_features"],
        "available_features": best_meta["available_features"],
    }

    return response

