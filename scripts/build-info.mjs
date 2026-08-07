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

// Matches vite.config.ts: in production, .env.production is authoritative
// (forced via `define`), so it wins over any process env var. In dev, fall back
// to the normal Vite behavior (process env, else .env.production, else .env).
const hasEnv = Object.prototype.hasOwnProperty.call(process.env, "VITE_API_URL");
const fileProd = loadDotEnv(".env.production").VITE_API_URL;
const fileGeneric = loadDotEnv(".env").VITE_API_URL;
const value = fileProd || (hasEnv ? (process.env.VITE_API_URL ?? "").trim() : fileGeneric || "");
const u = value.replace(/\/+$/g, "");

console.log("[build] VITE_API_URL (effective) = " + JSON.stringify(value || "(NOT SET)"));
if (fileProd) {
  console.log("[build]   ^ forced from .env.production (immune to deploy env vars)");
} else if (hasEnv) {
  console.log(
    "[build]   ^ comes from process.env" + (value ? "" : " (it is currently EMPTY!)")
  );
} else {
  console.log("[build]   ^ read from .env");
}
console.log("[build] baked base         = " + (u ? "//" + u : "(SAME ORIGIN)"));
if (!value) {
  console.warn(
    ">> WARNING: VITE_API_URL is empty — the frontend will call /api on its own domain " +
      "and never reach the backend."
  );
}
void isAbsolute; // node:fs import guard (kept for consistency)