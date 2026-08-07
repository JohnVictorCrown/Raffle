import { createClient, type Client, type Row } from "@libsql/client";

// Turso (remote) is the ONLY datastore — there is no local file fallback.
// One of TURSO_DATABASE_URL or TURSO_URL (+ their token aliases) is required;
// if missing the server refuses to start so we never silently diverge from
// production data.
const url = (process.env.TURSO_DATABASE_URL ?? process.env.TURSO_URL ?? "").trim();
if (!url) {
  throw new Error(
    "Turso is the only datastore. Set TURSO_URL (or TURSO_DATABASE_URL) (+ a token) in the environment; refusing to start with no remote database."
  );
}
const authToken = (process.env.TURSO_AUTH_TOKEN ?? process.env.TURSO_TOKEN ?? "").trim() || undefined;

export const db: Client = createClient(authToken ? { url, authToken } : { url });

// A single generic key/value table stores the current raffle, users, history,
// pending PIX orders and reservations. Values are JSON blobs keyed by stable
// string prefixes.
export async function initDb() {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS kv (
       key   TEXT PRIMARY KEY,
       data  TEXT NOT NULL
     ) STRICT;`
  );
}

export async function kvGet(key: string): Promise<string | null> {
  const rs = await db.execute({ sql: "SELECT data FROM kv WHERE key = ?", args: [key] });
  const row = rs.rows[0] as Row | undefined;
  return row ? String(row["data"]) : null;
}

// All writes are serialized through a single queue so rapid mutations to the
// same key (e.g. draw-then-replace, reserve-then-release) are applied in exact
// call order, and so `flushDb()` can guarantee durability before shutdown.
let writeQueue: Promise<void> = Promise.resolve();

export function kvSet(key: string, value: unknown): Promise<void> {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  writeQueue = writeQueue
    .then(async () => {
      await db.execute({ sql: "INSERT OR REPLACE INTO kv (key, data) VALUES (?, ?)", args: [key, data] });
    })
    .catch((err) => console.error("db write failed", err));
  return writeQueue;
}

export function kvDelete(key: string): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      await db.execute({ sql: "DELETE FROM kv WHERE key = ?", args: [key] });
    })
    .catch((err) => console.error("db write failed", err));
  return writeQueue;
}

export async function kvAll(prefix: string): Promise<{ key: string; data: string }[]> {
  const rs = await db.execute({
    sql: "SELECT key, data FROM kv WHERE key LIKE ?",
    args: [`${prefix}%`],
  });
  return rs.rows.map((row) => ({
    key: String(row["key"]),
    data: String(row["data"]),
  }));
}

export async function flushDb(): Promise<void> {
  await writeQueue;
}