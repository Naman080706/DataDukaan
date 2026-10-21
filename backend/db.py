"""Read-only DuckDB access. The agent never gets a writable connection."""
import os
import threading
import time
from datetime import date, datetime
from decimal import Decimal

import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("RETAIL_DB_PATH", os.path.join(ROOT, "data", "retail.duckdb"))
MAX_ROWS = 500
TIMEOUT_S = 15

_con = None
_lock = threading.Lock()


def get_connection() -> duckdb.DuckDBPyConnection:
    global _con
    with _lock:
        if _con is None:
            con = duckdb.connect(DB_PATH, read_only=True, config={"home_directory": "/tmp" if os.name != "nt" else ""})
            # Defence in depth on top of read_only + the SQL validator.
            con.execute("SET enable_external_access = false")
            con.execute("SET lock_configuration = true")
            _con = con
        return _con


def _jsonable(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, float):
        return round(v, 4)
    return v


def execute_readonly_sql(sql: str) -> dict:
    """Run an already-validated SELECT. Returns columns, rows (capped), timing."""
    cur = get_connection().cursor()
    timer = threading.Timer(TIMEOUT_S, cur.interrupt)
    timer.start()
    t0 = time.perf_counter()
    try:
        cur.execute(sql)
        columns = [d[0] for d in cur.description] if cur.description else []
        raw = cur.fetchmany(MAX_ROWS + 1)
    finally:
        timer.cancel()
        cur.close()
    truncated = len(raw) > MAX_ROWS
    rows = [[_jsonable(v) for v in r] for r in raw[:MAX_ROWS]]
    return {
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": truncated,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


def get_schema() -> dict:
    cur = get_connection().cursor()
    try:
        cols = cur.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name = 'transactions' ORDER BY ordinal_position"
        ).fetchall()
        n, dmin, dmax = cur.execute(
            "SELECT count(*), min(invoice_date), max(invoice_date) FROM transactions"
        ).fetchone()
    finally:
        cur.close()
    return {
        "tables": [{"name": "transactions", "columns": [{"name": c, "type": t} for c, t in cols]}],
        "row_count": n,
        "date_range": [_jsonable(dmin), _jsonable(dmax)],
    }
