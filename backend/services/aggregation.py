import numbers
import pandas as pd


MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
]


def _clean_metadata_value(value):
    """
    Convert pandas/NumPy missing values to None so FastAPI can
    serialize them cleanly.
    """
    if pd.isna(value):
        return None

    return value


def _build_security_map(transaction_data: pd.DataFrame) -> dict:
    """
    Build:

    {
        "NVDA": {
            "type": "common_stock",
            "name": "NVIDIA CORP"
        }
    }
    """

    metadata = (
        transaction_data[
            ["symbol", "security_type", "security_name"]
        ]
        .dropna(subset=["symbol"])
        .drop_duplicates(subset=["symbol"])
    )

    security_map = {}

    for row in metadata.itertuples(index=False):
        security_map[row.symbol] = {
            "type": _clean_metadata_value(row.security_type),
            "name": _clean_metadata_value(row.security_name),
        }

    return security_map


def _round_numeric_values(data: dict) -> None:
    """
    Recursively round numeric dictionary values.

    Strings such as security_name/security_type are left alone.
    """

    for key, value in data.items():

        if isinstance(value, dict):
            _round_numeric_values(value)

        elif isinstance(value, numbers.Number):
            data[key] = round(float(value), 2)


def calculate_cost_basis(
    transaction_data: pd.DataFrame
) -> dict:
    """
    For each account and symbol, calculate:

    Current position:
        - remaining_quantity
        - remaining_cost_basis
        - realized_gain_loss

    Historical activity:
        - total_quantity_acquired
        - total_quantity_sold

    Metadata:
        - security_type
        - security_name

    Definitions:

    total_quantity_acquired
        = bought shares + reinvested shares
    """

    # Don't mutate the original DataFrame.
    transaction_data = transaction_data.copy()

    priority = {
        "reinvestment": 0,
        "bought": 1,
        "sold": 2,
    }

    transaction_data["transaction_priority"] = (
        transaction_data["transaction_subtype"].map(priority)
    )

    transaction_data.sort_values(
        by=[
            "run_date",
            "transaction_priority",
        ],
        inplace=True,
    )

    unique_symbols = (
        transaction_data["symbol"]
        .dropna()
        .unique()
    )

    unique_accounts = (
        transaction_data["account_number"]
        .dropna()
        .unique()
    )

    security_map = _build_security_map(
        transaction_data
    )

    symbol_statistic = {}

    for account in unique_accounts:

        symbol_statistic[account] = {}

        for symbol in unique_symbols:

            transactions = transaction_data[
                (
                    transaction_data["symbol"]
                    == symbol
                )
                &
                (
                    transaction_data["account_number"]
                    == account
                )
            ]

            if transactions.empty:
                continue

            metadata = security_map.get(
                symbol,
                {
                    "type": None,
                    "name": None,
                },
            )

            stats = {
                # Current position
                "remaining_quantity": 0.0,
                "remaining_cost_basis": 0.0,
                "realized_gain_loss": 0.0,

                # Historical position activity
                "total_quantity_acquired": 0.0,
                "total_quantity_sold": 0.0,

                # Metadata
                "security_type": metadata["type"],
                "security_name": metadata["name"],
            }

            symbol_statistic[account][symbol] = stats

            # Process transactions chronologically
            for transaction in transactions.itertuples():

                quantity = float(
                    transaction.quantity
                )

                amount = float(
                    transaction.amount
                )

                action = (
                    transaction.transaction_subtype
                )

                # Reinvestment
                if action == "reinvestment":

                    if quantity < -1e-9:
                        raise ValueError(
                            f"Reinvestment has negative "
                            f"quantity for {symbol} "
                            f"in {account}: {quantity}"
                        )

                    acquisition_cost = -amount

                    # Current position
                    stats[
                        "remaining_quantity"
                    ] += quantity

                    stats[
                        "remaining_cost_basis"
                    ] += acquisition_cost

                    # Historical totals
                    stats[
                        "total_quantity_acquired"
                    ] += quantity

                # Bought
                elif action == "bought":

                    if quantity < -1e-9:
                        raise ValueError(
                            f"Buy has negative quantity "
                            f"for {symbol} "
                            f"in {account}: {quantity}"
                        )

                    purchase_cost = -amount

                    # Current position
                    stats[
                        "remaining_quantity"
                    ] += quantity

                    stats[
                        "remaining_cost_basis"
                    ] += purchase_cost

                    # Historical totals
                    stats[
                        "total_quantity_acquired"
                    ] += quantity

                # Sold
                elif action == "sold":

                    if quantity > 1e-9:
                        raise ValueError(
                            f"Sell has positive quantity "
                            f"for {symbol} "
                            f"in {account}: {quantity}"
                        )

                    quantity_sold = -quantity

                    if (
                        stats["remaining_quantity"]
                        <= 1e-9
                    ):
                        raise ValueError(
                            f"Attempted to sell "
                            f"{symbol} in {account} "
                            f"with no remaining shares."
                        )

                    if (
                        quantity_sold
                        >
                        stats["remaining_quantity"]
                        + 1e-9
                    ):
                        raise ValueError(
                            f"Sell quantity exceeds "
                            f"remaining quantity for "
                            f"{symbol} in {account}. "
                            f"Sold={quantity_sold}, "
                            f"Remaining="
                            f"{stats['remaining_quantity']}"
                        )

                    average_cost = (
                        stats[
                            "remaining_cost_basis"
                        ]
                        /
                        stats[
                            "remaining_quantity"
                        ]
                    )

                    basis_removed = (
                        average_cost
                        * quantity_sold
                    )

                    # Fidelity sale amount is positive.
                    sale_proceeds = amount

                    gain_loss = (
                        sale_proceeds
                        - basis_removed
                    )

                    # Current position
                    stats[
                        "remaining_quantity"
                    ] -= quantity_sold

                    stats[
                        "remaining_cost_basis"
                    ] -= basis_removed

                    # Historical totals
                    stats[
                        "total_quantity_sold"
                    ] += quantity_sold

                    stats[
                        "realized_gain_loss"
                    ] += gain_loss

                # Ignore anything that isn't relevant
                # to cost basis.
                else:
                    continue

                # Validation / floating point cleanup
                if (
                    stats["remaining_quantity"]
                    < -1e-9
                ):
                    raise ValueError(
                        f"Remaining quantity for "
                        f"{symbol} in {account} "
                        f"is negative: "
                        f"{stats['remaining_quantity']}"
                    )

                if (
                    stats["remaining_cost_basis"]
                    < -1e-7
                ):
                    raise ValueError(
                        f"Remaining cost basis for "
                        f"{symbol} in {account} "
                        f"is negative: "
                        f"{stats['remaining_cost_basis']}"
                    )

                # Position fully closed.
                if (
                    abs(
                        stats[
                            "remaining_quantity"
                        ]
                    )
                    < 1e-9
                ):
                    stats[
                        "remaining_quantity"
                    ] = 0.0

                    stats[
                        "remaining_cost_basis"
                    ] = 0.0

    _round_numeric_values(
        symbol_statistic
    )

    return symbol_statistic


def calculate_distribution(
    transaction_data: pd.DataFrame
) -> dict:
    """
    For each account and symbol, calculate:

        - total_dividend
        - total_long_term_cap_gain

        - monthly_dividend
        - monthly_long_term_cap_gain

        - security_type
        - security_name

    This function aggregates only the rows it receives.

    Later:

        API filters raw data
                ↓
        calculate_distribution(filtered_data)
                ↓
        monthly result already represents
        selected account/year/symbol
    """

    transaction_data = transaction_data.copy()

    unique_symbols = (
        transaction_data["symbol"]
        .dropna()
        .unique()
    )

    unique_accounts = (
        transaction_data["account_number"]
        .dropna()
        .unique()
    )

    security_map = _build_security_map(
        transaction_data
    )

    distribution_statistic = {}

    for account in unique_accounts:

        distribution_statistic[
            account
        ] = {}

        for symbol in unique_symbols:

            transactions = transaction_data[
                (
                    transaction_data["symbol"]
                    == symbol
                )
                &
                (
                    transaction_data["account_number"]
                    == account
                )
            ]

            if transactions.empty:
                continue

            metadata = security_map.get(
                symbol,
                {
                    "type": None,
                    "name": None,
                },
            )

            stats = {
                "total_dividend": 0.0,

                "total_long_term_cap_gain": 0.0,

                "monthly_dividend": {
                    month: 0.0
                    for month in MONTHS
                },

                "monthly_long_term_cap_gain": {
                    month: 0.0
                    for month in MONTHS
                },

                "security_type": metadata["type"],
                "security_name": metadata["name"],
            }

            distribution_statistic[
                account
            ][symbol] = stats

            # Process distributions
            for transaction in transactions.itertuples():

                action = (
                    transaction.transaction_subtype
                )

                amount = float(
                    transaction.amount
                )

                run_date = pd.Timestamp(
                    transaction.run_date
                )

                month = MONTHS[
                    run_date.month - 1
                ]

                # Ordinary dividend
                if action == "ordinary_dividend":

                    stats[
                        "total_dividend"
                    ] += amount

                    stats[
                        "monthly_dividend"
                    ][month] += amount
                    
                # Long-term capital gain distribution
                elif (
                    action
                    == "long_term_cap_gain"
                ):

                    stats[
                        "total_long_term_cap_gain"
                    ] += amount

                    stats[
                        "monthly_long_term_cap_gain"
                    ][month] += amount

    _round_numeric_values(
        distribution_statistic
    )

    return distribution_statistic