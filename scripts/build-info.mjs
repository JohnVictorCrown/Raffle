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

// Vite's precedence: a var already present in process.env is used even if empty
// and is NOT overwritten by .env files. So `hasOwn` (defined-but-empty) alone
// suppresses .env.production. Mirror that exactly.
const hasEnv = Object.prototype.hasOwnProperty.call(process.env, "VITE_API_URL");
const value = hasEnv
  ? (process.env.VITE_API_URL ?? "").trim()
  : loadDotEnv(".env.production").VITE_API_URL || loadDotEnv(".env").VITE_API_URL || "";
const u = value.replace(/\/+$/g, "");

console.log("[build] VITE_API_URL (effective) = " + JSON.stringify(value || "(NOT SET)"));
if (hasEnv) {
  console.log(
    "[build]   ^ comes from process.env; this OVERRIDES .env.production" +
      (value ? "" : " (it is currently EMPTY!)")
  );
} else {
  console.log("[build]   ^ read from .env.production");
}
console.log("[build] baked base         = " + (u ? "//" + u : "(SAME ORIGIN)"));
if (!value) {
  console.warn(
    ">> WARNING: VITE_API_URL is empty — the frontend will call /api on its own domain " +
      "and never reach the backend."
  );
}
void isAbsolute; // node:fs import guard (kept for consistency)