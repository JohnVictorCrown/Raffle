// Prints the resolved VITE_API_URL that Vite will bake into the bundle at
// build time, mirroring Vite's precedence: real env > .env.production > .env.
// Run automatically before `vite build` (see package.json "build:web") so
// deploy logs make it obvious whether the frontend targets the backend.
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function loadDotEnv(file) {
  try {
    const lines = readFileSync(resolve(process.cwd(), file), "utf8").split(/\r?\n/);
    const out = {};
    for (const line of lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || m[1] !== "VITE_API_URL") continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
    return out;
  } catch {
    return {};
  }
}

const value =
  (process.env.VITE_API_URL ?? "").trim() ||
  loadDotEnv(".env.production").VITE_API_URL ||
  loadDotEnv(".env").VITE_API_URL ||
  "";
const u = value.replace(/\/+$/g, "");

console.log("[build] VITE_API_URL = " + JSON.stringify(value || "(NOT SET)"));
console.log("[build] baked base     = " + (u ? "//" + u : "(SAME ORIGIN)"));
if (!value) {
  console.warn(
    ">> WARNING: VITE_API_URL is empty — the frontend will call /api on its own domain " +
      "and never reach the backend."
  );
}
void isAbsolute; // node:fs import guard (kept for consistency)