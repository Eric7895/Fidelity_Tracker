import sys
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

PROJECT_ROOT = Path(__file__).resolve().parents[2]

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.pipeline.preprocessing import preprocessing
import backend.services.aggregation as aggregation


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Initialize shared backend data for the lifetime of the FastAPI application.

    At application startup, run the transaction preprocessing pipeline,
    create reusable datasets, and store them in app.state so API endpoints
    can reuse the processed data without rerunning the pipeline for every
    request.

    Code before `yield` runs during application startup.
    Code after `yield` would run during application shutdown.
    """
    data = preprocessing()

    trade_data = data[
        data["transaction_type"].eq("trade")
        | data["transaction_subtype"].eq("reinvestment")
    ].drop_duplicates().reset_index(drop=True)

    distribution_data = data[
        data["transaction_type"].eq("distribution")
    ].drop_duplicates().reset_index(drop=True)

    app.state.data = data
    app.state.trade_data = trade_data
    app.state.distribution_data = distribution_data

    yield


app = FastAPI(
    title="Backend API",
    lifespan=lifespan,
)

# Vite and FastAPI run on different origins during local development.
# CORS allows the browser frontend to call this API directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Utility ---
def filter_data(
    data,
    account=None,
    year=None,
    symbol=None,
    transaction_type=None,
    transaction_subtype=None,
):
    """
    Apply optional filters to a transaction DataFrame.

    Any argument left as None is ignored.
    """
    filtered_data = data

    if account is not None:
        filtered_data = filtered_data[
            filtered_data["account_number"] == account
        ]

    if year is not None:
        filtered_data = filtered_data[
            filtered_data["run_date"].dt.year == year
        ]

    if symbol is not None:
        filtered_data = filtered_data[
            filtered_data["symbol"] == symbol
        ]

    if transaction_type is not None:
        filtered_data = filtered_data[
            filtered_data["transaction_type"] == transaction_type
        ]

    if transaction_subtype is not None:
        filtered_data = filtered_data[
            filtered_data["transaction_subtype"] == transaction_subtype
        ]

    return filtered_data

# --- API Routes ---
@app.get("/filters")
def get_filters(request: Request):
    """
    Return distinct values used to populate dashboard filter controls.
    """
    data = request.app.state.data

    unique_accounts = (
        data["account_number"]
        .dropna()
        .unique()
        .tolist()
    )

    unique_years = (
        data["run_date"]
        .dropna()
        .dt.year
        .unique()
        .tolist()
    )

    unique_symbols = (
        data["symbol"]
        .dropna()
        .unique()
        .tolist()
    )

    unique_transaction_types = (
        data["transaction_type"]
        .dropna()
        .unique()
        .tolist()
    )

    unique_transaction_subtypes = (
        data["transaction_subtype"]
        .dropna()
        .unique()
        .tolist()
    )

    return {
        "account": sorted(unique_accounts),
        "year": sorted(unique_years, reverse=True),
        "symbol": sorted(unique_symbols),
        "transaction_type": sorted(unique_transaction_types),
        "transaction_subtype": sorted(unique_transaction_subtypes),
        "status": [
            "open",
            "closed",
        ],
    }

@app.get("/cost_basis")
def cost_basis(
    request: Request,
    account: str | None = None,
    symbol: str | None = None,
    status: Literal["open", "closed"] | None = None,
):
    """
    Return all-time cost-basis statistics for positions.

    Only account and symbol are applied before aggregation because
    cost basis depends on the complete transaction history.

    Position status is applied after aggregation because open/closed
    depends on remaining quantity.
    """
    trade_data = request.app.state.trade_data

    filtered_data = filter_data(
        trade_data,
        account=account,
        symbol=symbol,
    )

    symbol_statistic = aggregation.calculate_cost_basis(
        filtered_data
    )

    if status is not None:
        filtered_statistics = {}

        for account_number, symbols in symbol_statistic.items():
            matching_symbols = {}

            for symbol_name, stats in symbols.items():
                is_open = stats["remaining_quantity"] > 1e-9

                if status == "open" and is_open:
                    matching_symbols[symbol_name] = stats

                elif status == "closed" and not is_open:
                    matching_symbols[symbol_name] = stats

            if matching_symbols:
                filtered_statistics[account_number] = matching_symbols

        symbol_statistic = filtered_statistics

    return symbol_statistic


@app.get("/dividend")
def dividend(
    request: Request,
    account: str | None = None,
    year: int | None = None,
    symbol: str | None = None,
):
    """
    Return dividend statistics after applying account, year,
    and symbol filters.

    Year filtering happens before aggregation so monthly dividend
    totals correspond to the selected year.
    """
    distribution_data = request.app.state.distribution_data

    filtered_data = filter_data(
        distribution_data,
        account=account,
        year=year,
        symbol=symbol,
    )

    symbol_statistic = aggregation.calculate_distribution(
        filtered_data
    )

    return symbol_statistic


@app.get("/principal")
def principal(
    request: Request,
    account: str | None = None,
):
    """
    Return all-time net principal contributed from outside institutions.

    Only electronic funds transfers are included. Transfers between Fidelity
    accounts are excluded so moving money internally does not inflate or reduce
    the account's principal.
    """
    data = request.app.state.data

    external_transfers = filter_data(
        data,
        account=account,
        transaction_type="transfer",
        transaction_subtype="electronic_funds_transfer",
    )

    deposits = external_transfers.loc[
        external_transfers["amount"] > 0,
        "amount",
    ].sum()

    withdrawals = -external_transfers.loc[
        external_transfers["amount"] < 0,
        "amount",
    ].sum()

    total_principal = external_transfers["amount"].sum()

    return {
        "total_principal": round(float(total_principal), 2),
        "external_deposits": round(float(deposits), 2),
        "external_withdrawals": round(float(withdrawals), 2),
    }


@app.get("/activity")
def activity(
    request: Request,
    account: str | None = None,
    year: int | None = None,
    symbol: str | None = None,
    transaction_type: str | None = None,
    transaction_subtype: str | None = None,
):
    """
    Return transaction activity after applying the selected filters.
    """
    data = request.app.state.data

    filtered_data = filter_data(
        data,
        account=account,
        year=year,
        symbol=symbol,
        transaction_type=transaction_type,
        transaction_subtype=transaction_subtype,
    )

    activity_data = filtered_data[
        [
            "account_number",
            "run_date",
            "symbol",
            "amount",
            "transaction_type",
            "transaction_subtype",
        ]
    ].copy()

    activity_data["month"] = (
        activity_data["run_date"]
        .dt.month_name()
        .str[:3]
    )

    activity_data["run_date"] = (
        activity_data["run_date"]
        .dt.strftime("%Y-%m-%d")
    )

    # Convert NaN / NaT to JSON-safe None
    activity_data = activity_data.astype(object).where(
        activity_data.notna(),
        None
    )

    return activity_data.to_dict(orient="records")


# Test using:
# uvicorn backend.api.api:app --reload
