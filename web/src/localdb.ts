// A database inside the browser (DuckDB-WASM) for a user's own file. The file is never uploaded:
// it is read here, turned into a table, and questions run against it locally.
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { Cell } from "./api";

export const MAX_FILE_MB = 200;

export interface DatasetProfile {
  source: string; // original file name
  kind: "retail" | "generic";
  table: "transactions" | "dataset";
  row_count: number;
  columns: { name: string; type: string }[];
  sample_rows: Cell[][];
  date_range: [string | null, string | null];
  countries: string[];
  mapping: { field: string; column: string }[]; // retail only: which of the user's columns fills each field
}

let dbPromise: Promise<AsyncDuckDB> | null = null;
let conn: AsyncDuckDBConnection | null = null;

async function getConn(): Promise<AsyncDuckDBConnection> {
  if (!dbPromise) {
    dbPromise = (async () => {
      // The ~35 MB engine is loaded from jsDelivr (pinned to the installed version) rather than shipped in the site.
      const duckdb = await import("@duckdb/duckdb-wasm");
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: "text/javascript" }));
      const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      return db;
    })();
  }
  const db = await dbPromise;
  if (!conn) conn = await db.connect();
  return conn;
}

// ---------- reading files ----------

function ext(name: string) {
  return name.toLowerCase().split(".").pop() ?? "";
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // SheetJS gives dates in local time (and can be a second off), so format the local fields, not UTC.
    if (isNaN(v.getTime())) return "";
    const d = new Date(Math.round(v.getTime() / 1000) * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return time === "00:00:00" ? day : `${day} ${time}`;
  }
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Excel isn't read by DuckDB in the browser, so convert the first non-empty sheet to CSV with SheetJS.
async function excelToCsv(buf: ArrayBuffer): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    if (rows.length > 1) return new TextEncoder().encode(rows.map((r) => r.map(csvEscape).join(",")).join("\n"));
  }
  throw new Error("The spreadsheet has no sheet with a header row and data.");
}

async function loadRaw(c: AsyncDuckDBConnection, file: File) {
  const db = await dbPromise!;
  const e = ext(file.name);
  let buf = new Uint8Array(await file.arrayBuffer());
  let reader: string;
  if (["xlsx", "xls", "xlsm", "ods"].includes(e)) {
    buf = await excelToCsv(buf.buffer as ArrayBuffer);
    reader = "read_csv_auto('upload.csv', header = true, sample_size = -1)";
  } else if (e === "parquet") {
    reader = "read_parquet('upload.parquet')";
  } else if (["json", "jsonl", "ndjson"].includes(e)) {
    reader = "read_json_auto('upload.json')";
  } else if (["csv", "tsv", "txt"].includes(e)) {
    reader = "read_csv_auto('upload.csv', header = true, sample_size = -1)";
  } else {
    throw new Error("Unsupported file type. Use CSV, TSV, Excel (.xlsx/.xls), JSON or Parquet.");
  }
  const fname = reader.match(/'([^']+)'/)![1];
  await db.registerFileBuffer(fname, buf);
  try {
    await c.query(`CREATE OR REPLACE TABLE raw AS SELECT * FROM ${reader}`);
  } finally {
    await db.dropFile(fname).catch(() => undefined);
  }
}

// ---------- understanding the columns ----------

function snake(name: string, i: number, seen: Set<string>): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = `column_${i + 1}`;
  if (/^\d/.test(s)) s = `c_${s}`;
  let out = s;
  for (let n = 2; seen.has(out); n++) out = `${s}_${n}`;
  seen.add(out);
  return out;
}

// Common names for each retail field in sales exports (order lines, POS exports, e-commerce reports).
const RETAIL_FIELDS: Record<string, string[]> = {
  invoice: ["invoice", "invoiceno", "invoice_no", "invoice_number", "invoice_id", "order_id", "orderid", "order_no", "order_number", "order", "transaction_id", "transaction", "bill_no", "bill_number", "receipt_no", "receipt_id"],
  stock_code: ["stockcode", "stock_code", "sku", "product_id", "productid", "product_code", "item_code", "item_id", "itemid", "article", "article_no"],
  description: ["description", "product", "product_name", "productname", "item", "item_name", "item_description", "product_description", "title"],
  quantity: ["quantity", "qty", "units", "quantity_ordered", "qty_ordered", "unit_count", "pieces"],
  invoice_date: ["invoicedate", "invoice_date", "order_date", "orderdate", "date", "transaction_date", "sale_date", "sales_date", "created_at", "timestamp", "datetime", "order_datetime", "bill_date"],
  price: ["price", "unitprice", "unit_price", "price_each", "priceeach", "item_price", "selling_price", "rate", "unit_cost"],
  total: ["sales", "total", "amount", "line_total", "total_price", "revenue", "total_amount", "line_amount", "net_amount", "value"],
  customer_id: ["customer_id", "customerid", "customer", "client_id", "customer_number", "customer_no", "buyer_id", "customer_name"],
  country: ["country", "country_name", "region", "market"],
};

function mapRetail(cols: string[]): Record<string, string> | null {
  const m: Record<string, string> = {};
  for (const [field, names] of Object.entries(RETAIL_FIELDS)) {
    const hit = names.find((n) => cols.includes(n));
    if (hit) m[field] = hit;
  }
  const ok = m.quantity && m.invoice_date && (m.price || m.total) && (m.stock_code || m.description);
  return ok ? m : null;
}

function retailSql(m: Record<string, string>, nonProduct: string[]): string {
  const q = (c?: string) => (c ? `"${c}"` : "NULL");
  const qty = `TRY_CAST(${q(m.quantity)} AS DOUBLE)`;
  const price = m.price ? `TRY_CAST(${q(m.price)} AS DOUBLE)` : `TRY_CAST(${q(m.total)} AS DOUBLE) / NULLIF(${qty}, 0)`;
  const date = `COALESCE(TRY_CAST(${q(m.invoice_date)} AS TIMESTAMP), try_strptime(CAST(${q(m.invoice_date)} AS VARCHAR), ['%d/%m/%Y %H:%M', '%m/%d/%Y %H:%M', '%d/%m/%Y', '%m/%d/%Y', '%d-%m-%Y', '%Y/%m/%d', '%d.%m.%Y']))`;
  const invoice = m.invoice ? `CAST(${q(m.invoice)} AS VARCHAR)` : `'ROW' || CAST(row_number() OVER () AS VARCHAR)`;
  const code = `CAST(${q(m.stock_code ?? m.description)} AS VARCHAR)`;
  const codes = nonProduct.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ") || "''";
  return `
    CREATE OR REPLACE TABLE transactions AS
    WITH base AS (
      SELECT ${invoice} AS invoice, ${code} AS stock_code, CAST(${q(m.description ?? m.stock_code)} AS VARCHAR) AS description,
             ${qty} AS quantity, ${date} AS invoice_date, ROUND(${price}, 2) AS price,
             CAST(${q(m.customer_id)} AS VARCHAR) AS customer_id, CAST(${q(m.country)} AS VARCHAR) AS country
      FROM clean)
    SELECT *, ROUND(quantity * price, 2) AS line_value,
           (starts_with(invoice, 'C') OR (quantity < 0 AND price > 0)) AS is_cancelled,
           quantity < 0 AS is_negative_qty, customer_id IS NOT NULL AS has_customer,
           NOT (upper(stock_code) IN (${codes}) OR upper(stock_code) LIKE 'GIFT\\_%' ESCAPE '\\'
                OR upper(stock_code) LIKE 'TEST%' OR upper(stock_code) LIKE 'ADJUST%'
                OR regexp_matches(lower(coalesce(description, '')), '\\b(shipping|delivery|postage|courier|freight|handling|service fee|bank charge|discount|gift card|voucher)\\b')) AS is_product,
           CASE WHEN starts_with(invoice, 'A') THEN 'bad_debt_adjustment'
                WHEN starts_with(invoice, 'C') OR (quantity < 0 AND price > 0) THEN 'cancellation'
                WHEN quantity < 0 THEN 'stock_adjustment'
                WHEN price <= 0 THEN 'zero_price'
                ELSE 'sale' END AS line_type
    FROM base WHERE quantity IS NOT NULL AND price IS NOT NULL`;
}

const FIELD_WORDS: Record<string, string> = {
  invoice: "Invoice / order number", stock_code: "Product code", description: "Product name", quantity: "Quantity",
  invoice_date: "Date", price: "Unit price", total: "Line total (price worked out from it)", customer_id: "Customer", country: "Country",
};

// ---------- running queries ----------

function plain(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 19);
  return String(v);
}

/** Run a SELECT and return plain rows. Big numbers and dates are converted in SQL so the browser gets simple values. */
export async function runQuery(sql: string, maxRows = 500): Promise<{ columns: string[]; rows: Cell[][]; truncated: boolean; elapsed_ms: number }> {
  const c = await getConn();
  const t0 = performance.now();
  let wrapped = `SELECT * FROM (${sql}) LIMIT ${maxRows + 1}`;
  try {
    const d = await c.query(`DESCRIBE ${wrapped}`);
    const cols = d.toArray().map((r) => r.toJSON() as { column_name: string; column_type: string });
    const sel = cols.map(({ column_name: n, column_type: t }) => {
      const id = `"${n.replace(/"/g, '""')}"`;
      if (/^(HUGEINT|UHUGEINT|BIGINT|UBIGINT|DECIMAL)/.test(t)) return `CAST(${id} AS DOUBLE) AS ${id}`;
      if (/^(DATE|TIMESTAMP|TIME|INTERVAL)/.test(t)) return `CAST(${id} AS VARCHAR) AS ${id}`;
      if (/(\[\]|STRUCT|MAP|UNION|LIST|BLOB|UUID)/.test(t)) return `CAST(${id} AS VARCHAR) AS ${id}`;
      return id;
    });
    wrapped = `SELECT ${sel.join(", ")} FROM (${wrapped})`;
  } catch {
    // DESCRIBE can fail on unusual queries; the plain query still runs below.
  }
  const t = await c.query(wrapped);
  const columns = t.schema.fields.map((f) => f.name);
  const all = t.toArray().map((r) => {
    const o = r.toJSON() as Record<string, unknown>;
    return columns.map((col) => plain(o[col]));
  });
  return { columns, rows: all.slice(0, maxRows), truncated: all.length > maxRows, elapsed_ms: Math.round(performance.now() - t0) };
}

// ---------- loading a file ----------

export async function loadDataset(file: File, nonProductCodes: string[]): Promise<DatasetProfile> {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`That file is over ${MAX_FILE_MB} MB. Try a smaller export or a Parquet file.`);
  const c = await getConn();
  await loadRaw(c, file);

  const desc = (await c.query("DESCRIBE raw")).toArray().map((r) => r.toJSON() as { column_name: string });
  if (!desc.length) throw new Error("The file has no columns.");
  const seen = new Set<string>();
  const names = desc.map((d, i) => ({ orig: d.column_name, clean: snake(d.column_name, i, seen) }));
  await c.query(`CREATE OR REPLACE TABLE clean AS SELECT ${names.map((n) => `"${n.orig.replace(/"/g, '""')}" AS "${n.clean}"`).join(", ")} FROM raw`);
  await c.query("DROP TABLE raw");

  const mapping = mapRetail(names.map((n) => n.clean));
  let table: DatasetProfile["table"] = "dataset";
  let kind: DatasetProfile["kind"] = "generic";
  if (mapping) {
    try {
      await c.query(retailSql(mapping, nonProductCodes));
      const ok = await runQuery("SELECT count(*) AS n, count(invoice_date) AS d FROM transactions");
      // Use the retail rules only if most rows have a usable date, quantity and price.
      if (Number(ok.rows[0][0]) > 0 && Number(ok.rows[0][1]) >= 0.8 * Number(ok.rows[0][0])) {
        table = "transactions";
        kind = "retail";
      }
    } catch {
      // Columns looked like sales data but couldn't be converted; treat it as a general table.
    }
  }
  if (kind === "generic") await c.query("CREATE OR REPLACE TABLE dataset AS SELECT * FROM clean");
  await c.query("DROP TABLE clean");

  const columns = (await c.query(`DESCRIBE ${table}`)).toArray().map((r) => {
    const o = r.toJSON() as { column_name: string; column_type: string };
    return { name: o.column_name, type: o.column_type };
  });
  const count = Number((await runQuery(`SELECT count(*) FROM ${table}`)).rows[0][0]);
  const sample = (await runQuery(`SELECT * FROM ${table} LIMIT 5`)).rows.map((r) => r.map((v) => (typeof v === "string" ? v.slice(0, 60) : v)));
  const dateCol = kind === "retail" ? "invoice_date" : columns.find((col) => /^(DATE|TIMESTAMP)/.test(col.type))?.name;
  let date_range: [string | null, string | null] = [null, null];
  if (dateCol) {
    const r = await runQuery(`SELECT CAST(min("${dateCol}") AS VARCHAR), CAST(max("${dateCol}") AS VARCHAR) FROM ${table}`);
    date_range = [r.rows[0][0] as string | null, r.rows[0][1] as string | null];
  }
  const countries =
    kind === "retail"
      ? (await runQuery("SELECT DISTINCT country FROM transactions WHERE country IS NOT NULL LIMIT 400", 400)).rows.map((r) => String(r[0]))
      : [];
  return {
    source: file.name, kind, table, row_count: count, columns, sample_rows: sample, date_range, countries,
    mapping: mapping && kind === "retail" ? Object.entries(mapping).map(([field, column]) => ({ field: FIELD_WORDS[field] ?? field, column })) : [],
  };
}
