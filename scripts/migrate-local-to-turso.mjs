import { createClient } from "@libsql/client";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// Parse .env directly (avoids loadEnvFile's "don't override existing process
// env" rule, which could silently use a stale token).
function envFromFile(name) {
  try {
    const lines = readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = new RegExp("^" + name + "\\s*=\\s*(.*)\\s*$").exec(line.trim());
      if (m) return m[1].trim().replace(/^"|"$/g, "");
    }
  } catch {}
  return "";
}

const remoteUrl = (envFromFile("TURSO_URL") || envFromFile("TURSO_DATABASE_URL") || process.env.TURSO_URL || "").trim();
const remoteTok = (envFromFile("TURSO_TOKEN") || envFromFile("TURSO_AUTH_TOKEN") || process.env.TURSO_TOKEN || "").trim();
const localPath = "file:" + join(process.cwd(), "server", "data", "rifa.db").replace(/\\/g, "/");

if (!remoteUrl || !remoteTok) {
  console.error("No valid Turso URL/token in .env — cannot migrate.");
  process.exit(1);
}

const local = createClient({ url: localPath });
const remote = createClient({ url: remoteUrl, authToken: remoteTok });

try {
  const rs = await local.execute({ sql: "SELECT key, data FROM kv ORDER BY key" });
  console.log("local rows:", rs.rows.length);

  await remote.execute(
    `CREATE TABLE IF NOT EXISTS kv ( key TEXT PRIMARY KEY, data TEXT NOT NULL ) STRICT;`
  );

  let done = 0;
  for (const row of rs.rows) {
    const key = String(row.key);
    const data = String(row.data);
    try {
      await remote.execute({ sql: "INSERT OR REPLACE INTO kv (key, data) VALUES (?, ?)", args: [key, data] });
      done++;
      console.log("migrated:", key);
    } catch (err) {
      console.error("failed on key:", key, "-", err.message);
    }
  }
  console.log("DONE. migrated", done, "rows into", remoteUrl);
} finally {
  await local.close();
  await remote.close();
}