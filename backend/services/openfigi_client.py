import csv
import os
from pathlib import Path

import pandas as pd
import re
import requests


# Shared OpenFIGI configuration
OPENFIGI_URL = "https://api.openfigi.com/v3/mapping"
OPENFIGI_TIMEOUT = 30
OPENFIGI_PUBLIC_BATCH_SIZE = 5
OPENFIGI_AUTH_BATCH_SIZE = 100


def _find_project_root() -> Path:
    """
    Find the project root containing the shared metadata folder.

    Expected layouts include:
        project/backend/services/openfigi_client.py
    """
    module_dir = Path(__file__).resolve().parent

    # Prefer an existing metadata folder found while walking upward.
    for directory in (module_dir, *module_dir.parents):
        if (directory / "metadata").is_dir():
            return directory

    # Fallbacks for a new project where metadata/ has not been created yet.
    if module_dir.name == "services" and module_dir.parent.name == "backend":
        return module_dir.parents[1]

    return module_dir.parent


PROJECT_ROOT = _find_project_root()
METADATA_DIR = PROJECT_ROOT / "metadata"
CUSIP_METADATA_FILE = METADATA_DIR / "cusip.csv"
SECURITY_METADATA_FILE = METADATA_DIR / "security.csv"


def _openfigi_settings() -> tuple[dict[str, str], int]:
    """
    Return request headers and the applicable OpenFIGI batch size.
    """
    api_key = os.getenv("OPENFIGI_API_KEY")
    headers = {"Content-Type": "application/json"}

    if api_key:
        headers["X-OPENFIGI-APIKEY"] = api_key
        return headers, OPENFIGI_AUTH_BATCH_SIZE

    return headers, OPENFIGI_PUBLIC_BATCH_SIZE


def _load_csv_metadata(
    local_file: str | Path,
    key_column: str,
    fieldnames: list[str],
) -> dict[str, dict[str, str]]:
    """
    Load complete records from a CSV metadata table.

    Malformed or incomplete rows are ignored. When duplicate keys exist,
    the last complete row wins.
    """
    path = Path(local_file)
    metadata: dict[str, dict[str, str]] = {}

    if not path.exists():
        return metadata

    with path.open("r", newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)

        if not reader.fieldnames or not set(fieldnames).issubset(reader.fieldnames):
            return metadata

        for row in reader:
            cleaned = {
                field: str(row.get(field, "")).strip()
                for field in fieldnames
            }

            if not all(cleaned.values()):
                continue

            key = cleaned[key_column].upper()
            cleaned[key_column] = key
            metadata[key] = cleaned

    return metadata


def _append_csv_records(
    local_file: str | Path,
    fieldnames: list[str],
    records: list[dict[str, str]],
) -> None:
    """
    Append complete records to a CSV metadata table.
    """
    if not records:
        return

    path = Path(local_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not path.exists() or path.stat().st_size == 0

    with path.open("a", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)

        if write_header:
            writer.writeheader()

        writer.writerows(records)


def _normalize_security_type(
    match: dict,
    security_name: str,
) -> tuple[str | None, str]:
    """
    Convert OpenFIGI metadata into the application's security taxonomy.

    Returns:
        (normalized_type, raw_type)

    An unrecognized type returns None so the record remains unresolved
    and can be handled by a separate fallback approach.
    """
    security_type = str(match.get("securityType") or "").strip()
    security_type2 = str(match.get("securityType2") or "").strip()
    market_sector = str(match.get("marketSector") or "").strip()

    security_type_raw = security_type2 or security_type

    classification_text = " ".join(
        [security_type, security_type2, market_sector, security_name]
    ).lower()

    if market_sector == "M-Mkt" or "money market" in classification_text:
        normalized = "money_market_fund"

    elif any(
        term in classification_text
        for term in [
            "exchange traded product",
            "exchange-traded product",
            "exchange traded fund",
            "exchange-traded fund",
            " etp",
            " etf",
        ]
    ):
        normalized = "etf"

    elif any(
        term in classification_text
        for term in ["closed-end fund", "closed end fund"]
    ):
        normalized = "closed_end_fund"

    elif any(
        term in classification_text
        for term in [
            "open-end fund",
            "open end fund",
            "mutual fund",
            "fund of funds",
        ]
    ):
        normalized = "mutual_fund"

    elif any(
        term in classification_text
        for term in ["unit investment trust", " uit"]
    ):
        normalized = "unit_investment_trust"

    elif any(
        term in classification_text
        for term in [
            "depositary receipt",
            "depositary share",
            " adr",
            " ads",
        ]
    ):
        normalized = "depositary_receipt"

    elif "preferred stock" in classification_text:
        normalized = "preferred_stock"

    elif "common stock" in classification_text:
        normalized = "common_stock"

    else:
        normalized = None

    return normalized, security_type_raw


def cusip_to_ticker(
    cusips: list[str],
    local_file: str | Path = CUSIP_METADATA_FILE,
) -> dict[str, str]:
    """
    Resolve CUSIPs to US ticker symbols.

    Complete metadata mappings are reused. Only successful new mappings are
    written to the CSV metadata table. Unresolved CUSIPs are omitted.
    """
    requested_cusips = sorted(
        {
            str(cusip).strip().upper()
            for cusip in cusips
            if pd.notna(cusip) and str(cusip).strip()
        }
    )

    if not requested_cusips:
        return {}

    fieldnames = ["cusip", "ticker", "source"]
    metadata = _load_csv_metadata(local_file, "cusip", fieldnames)
    remaining_cusips = [
        cusip for cusip in requested_cusips if cusip not in metadata
    ]

    headers, batch_size = _openfigi_settings()
    new_records: list[dict[str, str]] = []

    for start in range(0, len(remaining_cusips), batch_size):
        batch = remaining_cusips[start:start + batch_size]

        payload = [
            {
                "idType": "ID_CUSIP",
                "idValue": cusip,
                "exchCode": "US",
            }
            for cusip in batch
        ]

        try:
            response = requests.post(
                OPENFIGI_URL,
                json=payload,
                headers=headers,
                timeout=OPENFIGI_TIMEOUT,
            )
            response.raise_for_status()
            results = response.json()

        except (requests.RequestException, ValueError) as error:
            print(f"OpenFIGI CUSIP lookup failed: {error}")
            continue

        for cusip, result in zip(batch, results):
            if not isinstance(result, dict):
                continue

            if "error" in result:
                print(f"{cusip}: {result['error']}")
                continue

            candidates = [
                candidate
                for candidate in result.get("data", [])
                if candidate.get("ticker")
                and candidate.get("exchCode") == "US"
            ]

            if not candidates:
                continue

            match = max(
                candidates,
                key=lambda candidate: (
                    candidate.get("marketSector") == "Equity",
                    bool(candidate.get("compositeFIGI")),
                    bool(candidate.get("shareClassFIGI")),
                    bool(candidate.get("securityType2")),
                    bool(candidate.get("name")),
                ),
            )

            ticker = str(match.get("ticker") or "").strip().upper()

            if not ticker:
                continue

            record = {"cusip": cusip, "ticker": ticker, 'source': 'openfigi'}
            metadata[cusip] = record
            new_records.append(record)

    _append_csv_records(local_file, fieldnames, new_records)

    return {
        cusip: metadata[cusip]["ticker"]
        for cusip in requested_cusips
        if cusip in metadata
    }


def populate_security(
    symbols: list[str],
    local_file: str | Path = SECURITY_METADATA_FILE,
) -> dict[str, dict[str, str]]:
    """
    Resolve complete US security metadata through OpenFIGI.

    Complete metadata records are reused. Only records with a name, recognized
    normalized type, raw OpenFIGI type, and source are written to the metadata table.
    Incomplete or unresolved symbols are omitted.
    """
    requested_symbols = sorted(
        {
            str(symbol).strip().upper()
            for symbol in symbols
            if pd.notna(symbol) and str(symbol).strip()
        }
    )

    fidelity_crypto = {
        'ETH/USD': 'Ethereum',
        'BTC/USD': 'Bitcoin'
    }

    if not requested_symbols:
        return {}

    fieldnames = [
        "symbol",
        "security_name",
        "security_type",
        "security_type_raw",
        "security_source",
    ]

    metadata = _load_csv_metadata(local_file, "symbol", fieldnames)
    remaining_symbols = [
        symbol for symbol in requested_symbols if symbol not in metadata
    ]

    headers, batch_size = _openfigi_settings()
    new_records: list[dict[str, str]] = []

    # Take care of crypto entry
    for crypto in fidelity_crypto.keys():
        if crypto in remaining_symbols:
            record = {
                "symbol": crypto,
                "security_name": fidelity_crypto[crypto],
                "security_type": 'crypto',
                "security_type_raw": 'crypto',
                "security_source": "manual",
            }
            metadata[crypto] = record
            new_records.append(record)
            remaining_symbols.remove(crypto)

    for start in range(0, len(remaining_symbols), batch_size):
        batch = remaining_symbols[start:start + batch_size]

        payload = [
            {
                "idType": "TICKER",
                "idValue": symbol,
                "exchCode": "US",
            }
            for symbol in batch
        ]

        try:
            response = requests.post(
                OPENFIGI_URL,
                json=payload,
                headers=headers,
                timeout=OPENFIGI_TIMEOUT,
            )
            response.raise_for_status()
            results = response.json()

        except (requests.RequestException, ValueError) as error:
            print(f"OpenFIGI security lookup failed: {error}")
            continue

        for symbol, result in zip(batch, results):
            if not isinstance(result, dict):
                continue

            if "error" in result:
                print(f"{symbol}: {result['error']}")
                continue

            candidates = [
                candidate
                for candidate in result.get("data", [])
                if str(candidate.get("ticker") or "").strip().upper() == symbol
                and candidate.get("exchCode") == "US"
                and candidate.get("name")
            ]

            if not candidates:
                continue

            match = max(
                candidates,
                key=lambda candidate: (
                    candidate.get("marketSector") == "Equity",
                    bool(candidate.get("compositeFIGI")),
                    bool(candidate.get("shareClassFIGI")),
                    bool(candidate.get("securityType2")),
                    bool(candidate.get("securityType")),
                ),
            )

            security_name = str(
                match.get("name")
                or match.get("securityDescription")
                or ""
            ).strip()

            security_type, security_type_raw = _normalize_security_type(
                match,
                security_name,
            )

            # Store only complete security records.
            if not all(
                [
                    security_name,
                    security_type,
                    security_type_raw,
                ]
            ):
                continue

            record = {
                "symbol": symbol,
                "security_name": security_name,
                "security_type": security_type,
                "security_type_raw": security_type_raw,
                "security_source": "openfigi",
            }

            metadata[symbol] = record
            new_records.append(record)

    _append_csv_records(local_file, fieldnames, new_records)

    return {
        symbol: {
            "security_name": metadata[symbol]["security_name"],
            "security_type": metadata[symbol]["security_type"],
            "security_type_raw": metadata[symbol]["security_type_raw"],
            "security_source": metadata[symbol]["security_source"],
        }
        for symbol in requested_symbols
        if symbol in metadata
    }


def fill_missing_trade_symbols(
    df: pd.DataFrame,
    local_file: str | Path = CUSIP_METADATA_FILE,
) -> pd.DataFrame:
    """
    Fill missing trade symbols using direct tickers or metadata/API CUSIP mappings.

    The input DataFrame is updated in place. Unresolved rows are returned
    for a separate fallback approach.
    """
    missing_trade_symbol = (
        df["symbol"].isna()
        & df["transaction_type"].eq("trade")
    )

    action_candidates = (
        df.loc[missing_trade_symbol, "action"]
        .str.findall(r"\(([^()]*)\)")
    )

    description_candidates = (
        df.loc[missing_trade_symbol, "description"]
        .str.findall(r"\b(?=[A-Z0-9]*\d)[A-Z0-9]{9}\b")
    )

    candidate_identifiers = (
        action_candidates + description_candidates
    )

    # Create a new column to store candidate identifiers
    df["candidate_identifiers"] = pd.Series(
        [None] * len(df),
        index=df.index,
        dtype="object",
    )

    df.loc[
        missing_trade_symbol,
        "candidate_identifiers",
    ] = candidate_identifiers

    # Flatten the candidate identifiers into a single list for CUSIP lookup
    all_candidates = candidate_identifiers.explode()

    unique_cusips = (
        all_candidates[
            ~all_candidates.isin(["CASH", "MARGIN"])
            & all_candidates.str.fullmatch(
                r"(?=[A-Z0-9]*\d)[A-Z0-9]{9}",
                na=False,
            )
        ]
        .unique()
    )

    # Lookup CUSIP mappings
    cusip_mappings = cusip_to_ticker(
            unique_cusips,
            local_file=local_file,
        )

    if "cusip" not in df.columns:
        df["cusip"] = pd.Series(pd.NA, index=df.index, dtype="string")
    else:
        df["cusip"] = df["cusip"].astype("string")

    # Fill in the symbol and cusip columns based on candidate identifiers
    for i in missing_trade_symbol[missing_trade_symbol].index:
        candidates = df.at[i, "candidate_identifiers"]
        if isinstance(candidates, list):
            for candidate in candidates:
                if candidate in {"CASH", "MARGIN"}:
                    continue

                if re.fullmatch(r"[A-Z]{1,6}(?:[.-][A-Z])?", candidate):
                    df.at[i, "symbol"] = candidate
                    break

                elif candidate in cusip_mappings:
                    df.at[i, "cusip"] = candidate
                    df.at[i, "symbol"] = cusip_mappings[candidate]
                    break

    unresolved = missing_trade_symbol & df["symbol"].isna()

    columns = [
            column
            for column in ["action", "description", "cusip"]
            if column in df.columns
        ]

    df.drop(columns=["candidate_identifiers"], inplace=True)
    
    return df.loc[unresolved, columns].drop_duplicates()
