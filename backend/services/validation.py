import pandas as pd

TOLERANCE = 1e-9

def check_sign_consistency(df: pd.DataFrame) -> pd.DataFrame:

    """
    Return transactions whose amount sign conflicts with their subtype.
    """

    expected_positive = {
        "sold",
        "ordinary_dividend",
        "long_term_cap_gain",
    }

    expected_negative = {
        "bought",
        "reinvestment",
        "fee",
        "foreign_tax",
    }

    positive_errors = (
        df["transaction_subtype"].isin(expected_positive)
        & (df["amount"] <= TOLERANCE)
    )

    negative_errors = (
        df["transaction_subtype"].isin(expected_negative)
        & (df["amount"] >= -TOLERANCE)
    )

    missing_amount = (
        df["transaction_subtype"].isin(
            expected_positive | expected_negative
        )
        & df["amount"].isna()
    )

    errors = df[
        positive_errors
        | negative_errors
        | missing_amount
    ].copy()

    return errors

def check_reinvestment(df: pd.DataFrame) -> pd.DataFrame:
    """
    Distributions from mutual fund and money market (SPAXX) will be reinvest

    Checks if they sum up to zero
    Rule:
    - Can't be less than zero (indicator of missing distribution)
    """
    fund_types = {
        "mutual_fund",
        "money_market_fund",
    }

    fund_distribution_subtypes = {
        "ordinary_dividend",
        "long_term_cap_gain",
        "reinvestment",
    }

    fund_distributions = df[
        df["security_type"].isin(fund_types)
        & df["transaction_subtype"].isin(fund_distribution_subtypes)
    ].copy()

    # Distribution and reinvestment rows should net to zero
    distribution_check = (
        fund_distributions
        .groupby(
            [
                "account_number",
                "symbol",
                "run_date",
            ],
            dropna=False,
        )
        .agg(
            net_amount=("amount", "sum"),
            transaction_count=("amount", "size"),
            subtypes=(
                "transaction_subtype",
                lambda values: sorted(set(values)),
            ),
        )
        .reset_index()
    )

    incorrect_distributions = distribution_check[
        distribution_check["net_amount"].abs() > TOLERANCE
    ]

    return incorrect_distributions
