import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

// The committed .env.production is the authoritative VITE_API_URL in production
// builds. Vite normally lets a real process env var (even an empty one from the
// deploy platform) override .env files — forcing the value here with `define`
// makes the bundle deterministic and immune to that.
function readEnvFile(file: string): Record<string, string> {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const out: Record<string, string> = {};
    for (const line of lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
    return out;
  } catch {
    return {};
  }
}

const forced: Record<string, string> = {};
const prodEnv = readEnvFile(".env.production");
if (prodEnv.VITE_API_URL) {
  forced["import.meta.env.VITE_API_URL"] = JSON.stringify(prodEnv.VITE_API_URL);
}

export default defineConfig({
  define: forced,
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
  },
});
