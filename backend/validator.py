"""Parser-based SQL validation: one read-only SELECT over the transactions table."""
import re

import sqlglot
from sqlglot import exp

ALLOWED_TABLES = {"transactions"}
# DuckDB table functions / functions that touch files, network or settings.
BLOCKED_FUNCTIONS = re.compile(
    r"^(read_\w+|glob|sniff_csv|parquet_\w+|query|query_table|current_setting|getenv|"
    r"duckdb_\w+|pragma_\w+|load|install|httpfs\w*|iceberg\w*|delta_\w+|sqlite_\w+|postgres_\w+|mysql_\w+)$",
    re.IGNORECASE,
)
BLOCKED_NODES = tuple(
    getattr(exp, n)
    for n in (
        "Insert", "Update", "Delete", "Drop", "Create", "Alter", "Command", "Copy", "Set", "Pragma",
        "Transaction", "Commit", "Rollback", "Merge", "Use", "Attach", "Detach", "Into", "TruncateTable",
        "LoadData", "Grant", "Install", "Export",
    )
    if hasattr(exp, n)
)


class ValidationError(Exception):
    pass


def validate_sql(sql: str, allowed_tables: set[str] | None = None) -> str:
    """Return cleaned SQL or raise ValidationError with a user-readable reason."""
    if not sql or not sql.strip():
        raise ValidationError("Empty SQL.")
    cleaned = sql.strip().rstrip(";").strip()
    try:
        statements = [s for s in sqlglot.parse(cleaned, read="duckdb") if s is not None]
    except sqlglot.errors.ParseError as e:
        raise ValidationError(f"SQL could not be parsed: {str(e).splitlines()[0]}")
    if len(statements) != 1:
        raise ValidationError(f"Exactly one statement is allowed, got {len(statements)}.")
    stmt = statements[0]
    if not isinstance(stmt, exp.Query):
        raise ValidationError(f"Only SELECT queries are allowed (got {stmt.key.upper()}).")

    cte_names = {c.alias_or_name.lower() for c in stmt.find_all(exp.CTE)}
    for node in stmt.walk():
        if isinstance(node, BLOCKED_NODES):
            raise ValidationError(f"Blocked operation: {node.key.upper()}.")
        if isinstance(node, exp.Table):
            name = node.name.lower()
            if isinstance(node.this, exp.Func) or not name:
                raise ValidationError("Table functions are not allowed.")
            if name not in (allowed_tables or ALLOWED_TABLES) | cte_names:
                raise ValidationError(f"Unknown or disallowed table: {node.name}.")
            if node.args.get("db") or node.args.get("catalog"):
                raise ValidationError("Qualified table names are not allowed.")
        if isinstance(node, exp.Func):
            fname = node.sql_name() if not isinstance(node, exp.Anonymous) else node.name
            if BLOCKED_FUNCTIONS.match(fname or ""):
                raise ValidationError(f"Function not allowed: {fname}.")
    return cleaned
