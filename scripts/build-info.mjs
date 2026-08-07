// Prints the VITE_API_URL that Vite will bake into the bundle at build time.
// Run automatically before `vite build` (see package.json "build:web") so
// deploy logs make it obvious whether the frontend targets the backend.
const v = (process.env.VITE_API_URL ?? "").trim();
const u = v.replace(/\/+$/g, "");
console.log("[build] VITE_API_URL = " + JSON.stringify(process.env.VITE_API_URL || "(NOT SET)"));
console.log("[build] baked base     = " + (u ? "//" + u : "(SAME ORIGIN)"));
if (!v) {
  console.warn(
    ">> WARNING: VITE_API_URL is empty — the frontend will call /api on its own domain " +
      "and never reach the backend. Set VITE_API_URL on the deployed service."
  );
}