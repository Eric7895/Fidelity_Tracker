import logging
import sys
from pathlib import Path
from time import perf_counter

# Set project directory to root before importing backend modules.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
LOG_DIR = PROJECT_ROOT / "logs"
LOG_FILE = LOG_DIR / "preprocessing_log.txt"

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import numpy as np
import pandas as pd

from backend.services.openfigi_client import (
    fill_missing_trade_symbols,
    populate_security,
)
from backend.services.validation import (
    check_reinvestment,
    check_sign_consistency,
)


LOGGER_NAME = "fidelity_tracker.preprocessing"
logger = logging.getLogger(LOGGER_NAME)


def configure_logging(
    log_file: Path = LOG_FILE,
    verbose: bool = True,
) -> logging.Logger:
    """
    Configure logging for one preprocessing run.

    Each run recreates the text log and records DEBUG-or-higher messages
    in the file. The terminal shows INFO-or-higher messages when verbose
    is True, and WARNING-or-higher messages when verbose is False.
    """
    # FileHandler cannot create its parent directory.
    log_file.parent.mkdir(parents=True, exist_ok=True)

    # A logger's level is the first filter. DEBUG allows every standard
    # severity level to reach the attached handlers.
    logger.setLevel(logging.DEBUG)

    # Prevent this logger's records from also being handled by the root logger,
    # which could display the same message twice.
    logger.propagate = False

    # preprocessing() may run more than once in the same Python process,
    # especially after FastAPI is introduced. Remove and close the previous
    # handlers before attaching fresh ones.
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
        handler.close()

    # A formatter controls how each LogRecord appears.
    # asctime is generated automatically when the record is formatted.
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # mode="w" truncates the previous preprocessing log when this handler
    # is created, giving each pipeline run a fresh file.
    file_handler = logging.FileHandler(
        log_file,
        mode="w",
        encoding="utf-8",
    )

    # The file keeps detailed diagnostic messages.
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(formatter)

    # StreamHandler sends messages to the terminal.
    console_handler = logging.StreamHandler()

    # Verbosity controls only terminal output. The file still receives
    # every DEBUG-or-higher record.
    console_handler.setLevel(
        logging.INFO if verbose else logging.WARNING
    )
    console_handler.setFormatter(formatter)

    # A logger can send the same LogRecord to several destinations.
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger


def load_transactions(
    summary: dict,
    data_dir: Path = DATA_DIR,
) -> pd.DataFrame:
    """
    Read, clean, and concatenate all CSV files in the data directory.
    """
    csv_files = sorted(data_dir.glob("*.csv"))

    if not csv_files:
        raise FileNotFoundError(f"No CSV files found in: {data_dir}")

    cleaned_frames = []
    comments_removed = 0

    for file in csv_files:
        raw = pd.read_csv(file)
        cleaned = raw.dropna(subset=["Account"])
        removed = len(raw) - len(cleaned)

        cleaned_frames.append(cleaned)
        comments_removed += removed

        logger.info(
            "Loaded %s: %d transaction rows; %d comment rows removed",
            file.name,
            len(cleaned),
            removed,
        )

    data = pd.concat(cleaned_frames, ignore_index=True)

    summary["files_loaded"] = [file.name for file in csv_files]
    summary["comments_removed"] = comments_removed
    summary["initial_shape"] = data.shape

    return data


def rename_columns(df: pd.DataFrame) -> None:
    """
    Rename Fidelity columns in place.
    """
    name_dict = {
        "Price ($)": "price",
        "Quantity": "quantity",
        "Commission ($)": "commission",
        "Fees ($)": "fees",
        "Accrued Interest ($)": "accrued_interest",
        "Amount ($)": "amount",
        "Account": "account",
        "Account Number": "account_number",
        "Action": "action",
        "Symbol": "symbol",
        "Description": "description",
        "Type": "type",
        "Run Date": "run_date",
        "Settlement Date": "settlement_date",
    }

    df.rename(columns=name_dict, inplace=True)
    logger.debug("Columns renamed: %s", list(df.columns))


def enforce_types(df: pd.DataFrame) -> None:
    """
    Convert numeric and date columns and report values coerced to null.
    """
    numeric_columns = [
        "price",
        "quantity",
        "commission",
        "fees",
        "accrued_interest",
        "amount",
    ]
    date_columns = ["run_date", "settlement_date"]

    for column in numeric_columns:
        non_null_before = df[column].notna().sum()
        df[column] = pd.to_numeric(df[column], errors="coerce")
        coerced = non_null_before - df[column].notna().sum()

        if coerced:
            logger.warning(
                "%s values in %s could not be converted to numeric",
                coerced,
                column,
            )

    for column in date_columns:
        non_null_before = df[column].notna().sum()
        df[column] = pd.to_datetime(
            df[column],
            format="%m/%d/%Y",
            errors="coerce",
        )
        coerced = non_null_before - df[column].notna().sum()

        if coerced:
            logger.warning(
                "%s values in %s could not be converted to dates",
                coerced,
                column,
            )


def remove_duplicates(
    df: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Detect repeated transaction keys and remove duplicated sell rows only
    when the symbol's total quantity would otherwise remain negative.

    Always retain the first occurrence, inspect sell rows from newest to oldest.
    """
    pk = [
        "run_date",
        "account_number",
        "symbol",
        "price",
        "quantity",
        "amount",
        "settlement_date",
        "transaction_subtype",
    ]

    cleaned_df = df.copy()
    duplicate = cleaned_df[
        cleaned_df.duplicated(subset=pk, keep="first")
    ].copy()

    if duplicate.empty:
        logger.info("No repeated transaction keys found")
        return cleaned_df, duplicate

    logger.warning("Repeated transaction keys found: %d", len(duplicate))

    removed_index = []
    tolerance = 1e-9

    # Review duplicated transactions separately for each account and symbol.
    checklist = (
        duplicate[["account_number", "symbol"]]
        .dropna()
        .drop_duplicates()
    )

    for account_number, ticker in checklist.itertuples(index=False, name=None):
        subset = cleaned_df[
            cleaned_df["account_number"].eq(account_number)
            & cleaned_df["symbol"].eq(ticker)
        ].sort_values(by=["run_date", "settlement_date"])

        checker = subset["quantity"].sum(skipna=True)

        if abs(checker) < tolerance:
            checker = 0.0

        logger.debug(
            "%s | %s total quantity before duplicate review: %s",
            account_number,
            ticker,
            checker,
        )

        if checker < 0:
            candidates = duplicate[
                duplicate["account_number"].eq(account_number)
                & duplicate["symbol"].eq(ticker)
                & duplicate["quantity"].lt(0)
            ].sort_values(
                by=["run_date", "settlement_date"],
                ascending=False,
            )

            for index, row in candidates.iterrows():
                removed_index.append(index)
                checker -= row["quantity"]

                logger.warning(
                    "Removed duplicate index %s for account %s, symbol %s: "
                    "quantity=%s; adjusted balance=%s",
                    index,
                    account_number,
                    ticker,
                    row["quantity"],
                    checker,
                )

                if checker >= 0:
                    break

            if checker < 0:
                logger.error(
                    "Account %s, symbol %s still has negative quantity "
                    "after duplicate review: %s",
                    account_number,
                    ticker,
                    checker,
                )
        else:
            logger.debug(
                "Repeated rows retained for account %s, symbol %s",
                account_number,
                ticker,
            )

    removed_rows = cleaned_df.loc[removed_index].copy()
    cleaned_df = cleaned_df.drop(index=removed_index)

    logger.info("Duplicate rows removed: %d", len(removed_rows))
    return cleaned_df, removed_rows


def classify_transactions(df: pd.DataFrame) -> None:
    """
    Create more specific and detail label for every transaction 
    For specific details: visit eda.ipynb
    """
    # Organize each row by transaction type and subtype
    action = df["action"].fillna("")
    description = df["description"].fillna("")

    # Trade actions
    is_sold = action.str.contains(r"\bsold\b", case=False)
    is_bought = action.str.contains(r"\bbought\b", case=False)
    is_trade = is_sold | is_bought

    # Distribution actions
    # Security type will later distinguish stock, ETF, mutual-fund,
    # and money-market dividends.
    is_reinvestment = action.str.contains(r"\breinvestment\b", case=False)
    is_ordinary_dividend = action.str.contains(r"\bdividend\b", case=False)

    is_long_term_cap_gain = action.str.contains(
        r"\blong[-\s]+term\s+cap(?:ital)?\s+gain\b",
        case=False,
    )

    is_distribution = (
        is_reinvestment
        | is_ordinary_dividend
        | is_long_term_cap_gain
    )

    # Transfer actions
    is_transfer = action.str.contains(r"\btransfer\b", case=False)

    is_electronic_funds_transfer = action.str.contains(
        r"\b(?:electronic funds transfer|eft)\b",
        case=False,
    )

    is_internal_account_transfer = (
        is_transfer
        & action.str.contains(r"\b(?:brokerage|crypto)\b", case=False)
    )

    # Expense actions
    is_fee = action.str.contains(r"\bfee charged\b", case=False)
    is_foreign_tax = action.str.contains(r"\bforeign tax paid\b", case=False)
    is_expense = is_fee | is_foreign_tax

    # Assign the broad transaction category
    df["transaction_type"] = np.select(
        [
            is_trade,
            is_distribution,
            is_transfer,
            is_expense,
        ],
        [
            "trade",
            "distribution",
            "transfer",
            "expense",
        ],
        default="other",
    )

    # Assign the specific transaction action
    # More specific conditions must appear before broader conditions.
    df["transaction_subtype"] = np.select(
        [
            is_sold,
            is_bought,
            is_reinvestment,
            is_long_term_cap_gain,
            is_ordinary_dividend,
            is_electronic_funds_transfer,
            is_internal_account_transfer,
            is_transfer,
            is_fee,
            is_foreign_tax,
        ],
        [
            "sold",
            "bought",
            "reinvestment",
            "long_term_cap_gain",
            "ordinary_dividend",
            "electronic_funds_transfer",
            "internal_account_transfer",
            "other_transfer",
            "fee",
            "foreign_tax",
        ],
        default="other",
    )

    return None



def _log_value_counts(title: str, values: pd.Series) -> None:
    """
    Write compact value counts to the log.
    """
    logger.info("%s", title)
    for label, count in values.value_counts(dropna=False).items():
        logger.info("  %s: %d", label, count)


def _log_summary(summary: dict) -> None:
    """
    Write the final structured pipeline summary.
    """
    logger.info("=" * 60)
    logger.info("PREPROCESSING SUMMARY")
    logger.info("=" * 60)

    logger.info("Files loaded: %s", ", ".join(summary["files_loaded"]))
    logger.info("Comment rows removed: %d", summary["comments_removed"])
    logger.info("Initial shape: %s", summary["initial_shape"])
    logger.info("Final shape: %s", summary["final_shape"])
    logger.info("Duplicate rows removed: %d", summary["duplicates_removed"])
    logger.info("Missing-symbol rows remaining: %d", summary["unresolved_symbol_rows"])
    logger.info("Resolved unique securities: %d", summary["resolved_securities"])
    logger.info("Unresolved security metadata: %d", summary["unresolved_securities"])
    logger.info("Sign validation errors: %d", summary["sign_errors"])
    logger.info("Reinvestment validation errors: %d", summary["reinvestment_errors"])
    logger.info("Date range: %s to %s", summary["date_min"], summary["date_max"])
    logger.info("Final columns: %s", ", ".join(summary["final_columns"]))
    logger.info("Runtime: %.3f seconds", summary["runtime_seconds"])
    logger.info("Log file: %s", LOG_FILE)


def preprocessing(verbose: bool = True) -> pd.DataFrame:
    """
    Run the transaction preprocessing pipeline.
    """
    configure_logging(verbose=verbose)
    started = perf_counter()
    summary: dict = {}

    logger.info("Preprocessing run started")
    logger.info("Project root: %s", PROJECT_ROOT)
    logger.info("Data directory: %s", DATA_DIR)

    try:
        data = load_transactions(summary)
        logger.debug("Raw columns: %s", data.columns.tolist())
        logger.info("Combined raw transaction shape: %s", data.shape)

        rename_columns(data)
        logger.debug("Renamed columns: %s", data.columns.tolist())
        enforce_types(data)

        # Add an year column for the year filter
        data['year'] = data['run_date'].dt.year
        
        classify_transactions(data)

        _log_value_counts("Transaction types:", data["transaction_type"])
        _log_value_counts("Transaction subtypes:", data["transaction_subtype"])

        unresolved_symbol_rows = fill_missing_trade_symbols(data)
        summary["unresolved_symbol_rows"] = len(unresolved_symbol_rows)

        if unresolved_symbol_rows.empty:
            logger.info("All eligible missing symbols were resolved")
        else:
            logger.warning(
                "Missing-symbol rows still unresolved: %d",
                len(unresolved_symbol_rows),
            )
            logger.debug(
                "Unresolved symbol records: %s",
                unresolved_symbol_rows.head(10).to_dict(orient="records"),
            )

        data, removed_duplicates = remove_duplicates(data)
        summary["duplicates_removed"] = len(removed_duplicates)

        requested_symbols = set(data["symbol"].dropna().astype(str).unique())
        security_map = populate_security(sorted(requested_symbols))

        resolved_symbols = set(security_map)
        unresolved_securities = sorted(requested_symbols - resolved_symbols)

        summary["resolved_securities"] = len(resolved_symbols)
        summary["unresolved_securities"] = len(unresolved_securities)

        if unresolved_securities:
            logger.warning(
                "Security metadata unresolved for %d symbols: %s",
                len(unresolved_securities),
                ", ".join(unresolved_securities),
            )
        else:
            logger.info("Security metadata resolved for every unique symbol")

        security_table = pd.DataFrame.from_dict(
            security_map,
            orient="index",
        )
        security_table.index.name = "symbol"

        data = data.join(
            security_table,
            on="symbol",
            how="left",
            validate="many_to_one",
        )

        # Create empty columns to prevent KeyError
        if len(security_map) == 0:
            security_columns = [
                "security_name",
                "security_type",
                "security_type_raw",
                "security_source",
            ]

            for i in security_columns:
                data[i] = None

        sign_errors = check_sign_consistency(data)
        reinvestment_errors = check_reinvestment(data)

        summary["sign_errors"] = len(sign_errors)
        summary["reinvestment_errors"] = len(reinvestment_errors)

        if sign_errors.empty:
            logger.info("Sign validation passed")
        else:
            logger.error("Invalid transaction signs: %d", len(sign_errors))
            logger.debug(
                "Sign-error records: %s",
                sign_errors.head(10).to_dict(orient="records"),
            )

        if reinvestment_errors.empty:
            logger.info("Reinvestment validation passed")
        else:
            logger.error(
                "Incorrect or unmatched fund distributions: %d",
                len(reinvestment_errors),
            )
            logger.debug(
                "Reinvestment-error records: %s",
                reinvestment_errors.head(10).to_dict(orient="records"),
            )

        summary["final_shape"] = data.shape
        summary["final_columns"] = data.columns.astype(str).tolist()
        summary["date_min"] = data["run_date"].min()
        summary["date_max"] = data["run_date"].max()
        summary["runtime_seconds"] = perf_counter() - started

        _log_summary(summary)
        logger.info("Preprocessing run completed successfully")

        data.sort_values(by=['run_date'], inplace=True)

        return data

    except Exception:
        logger.exception("Preprocessing run failed")
        raise


if __name__ == "__main__":
    preprocessing()
