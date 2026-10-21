"""One-time ingestion: Online Retail II (UCI, CC BY 4.0) xlsx -> data/retail.duckdb.

Run: python scripts/ingest.py
Reads both yearly sheets, de-duplicates the overlap between them, standardises
types and adds the derived flag columns described in DATA_RULES.md.
"""
import os
import sys

import duckdb
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_XLSX = os.path.join(ROOT, "data", "raw", "online_retail_II.xlsx")
CACHE = os.path.join(ROOT, "data", "raw", "combined.parquet")
DB_PATH = os.path.join(ROOT, "data", "retail.duckdb")

sys.path.insert(0, ROOT)
from backend.rules import NON_PRODUCT_CODES_SQL  # noqa: E402


def load_raw() -> pd.DataFrame:
    if os.path.exists(CACHE):
        return pd.read_parquet(CACHE)
    sheets = pd.read_excel(RAW_XLSX, sheet_name=None, dtype={"Invoice": str, "StockCode": str})
    frames = []
    for name, df in sheets.items():
        df["source_sheet"] = name
        frames.append(df)
        print(f"sheet {name}: {len(df):,} rows")
    df = pd.concat(frames, ignore_index=True)
    df["Customer ID"] = df["Customer ID"].astype("Int64").astype(str).replace("<NA>", None)
    df["Description"] = df["Description"].astype(str).str.strip().replace({"nan": None})
    df.to_parquet(CACHE, index=False)
    return df


def main() -> None:
    df = load_raw()
    print(f"raw rows (both sheets): {len(df):,}")
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    con = duckdb.connect(DB_PATH)
    con.register("raw_df", df)

    # Sheet 2 (2010-2011) starts on 2010-12-01, which is also inside sheet 1.
    # Keep the overlapping days from sheet 1 only so those lines are not counted twice.
    con.execute(
        """
        CREATE TEMP TABLE raw AS
        SELECT * FROM raw_df
        WHERE NOT (source_sheet = 'Year 2010-2011'
                   AND "InvoiceDate" <= (SELECT max("InvoiceDate") FROM raw_df WHERE source_sheet = 'Year 2009-2010'))
        """
    )
    print("rows after removing sheet overlap:", con.execute("SELECT count(*) FROM raw").fetchone()[0])

    con.execute(
        f"""
        CREATE TABLE transactions AS
        SELECT
            CAST("Invoice" AS VARCHAR)                       AS invoice,
            CAST("StockCode" AS VARCHAR)                     AS stock_code,
            "Description"                                    AS description,
            CAST("Quantity" AS INTEGER)                      AS quantity,
            CAST("InvoiceDate" AS TIMESTAMP)                 AS invoice_date,
            ROUND(CAST("Price" AS DOUBLE), 2)                AS price,
            "Customer ID"                                    AS customer_id,
            "Country"                                        AS country,
            ROUND(CAST("Quantity" AS DOUBLE) * CAST("Price" AS DOUBLE), 2) AS line_value,
            starts_with("Invoice", 'C')                      AS is_cancelled,
            "Quantity" < 0                                   AS is_negative_qty,
            "Customer ID" IS NOT NULL                        AS has_customer,
            NOT (upper("StockCode") IN ({NON_PRODUCT_CODES_SQL})
                 OR upper("StockCode") LIKE 'GIFT\\_%' ESCAPE '\\'
                 OR upper("StockCode") LIKE 'TEST%'
                 OR upper("StockCode") LIKE 'ADJUST%')       AS is_product,
            CASE
                WHEN starts_with("Invoice", 'A')                     THEN 'bad_debt_adjustment'
                WHEN starts_with("Invoice", 'C')                     THEN 'cancellation'
                WHEN "Quantity" < 0                                  THEN 'stock_adjustment'
                WHEN "Price" <= 0                                    THEN 'zero_price'
                ELSE 'sale'
            END                                              AS line_type
        FROM raw
        ORDER BY invoice_date, invoice
        """
    )

    for row in con.execute(
        "SELECT line_type, count(*), round(sum(line_value), 2) FROM transactions GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall():
        print(row)
    print(con.execute("SELECT min(invoice_date), max(invoice_date), count(*) FROM transactions").fetchone())
    con.close()
    print("wrote", DB_PATH, f"{os.path.getsize(DB_PATH) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
