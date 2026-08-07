# Golden Lion Rifa

A lion-themed raffle web app (Rifa) — a vanilla TypeScript SPA on **Vite** that talks to a **Bun/Node** API, with **Mercado Pago PIX payments** and **Brevo** email delivery. Bilingual — English and Portuguese.

## Features

- Golden-lion boot screen with background audio
- Create a raffle (title, prize, number of tickets, price, currency)
- Buy numbers via the **Mercado Pago PIX payment gateway** (QR code displayed, status polled, numbers held/reserved on approval)
- Auto-draw a winner with a random delay once the raffle sells out (winner + participants notified by email)
- Winners withdraw their prize via PIX from a claim link emailed to them
- "My raffles" page to track participations and results (by code or email)
- Language toggle (English / Português)
- Bright yellow-and-gold "tigrinho"-style theme over dark sub-tone panels

## Setup

```bash
bun install                # install dependencies
cp .env.example .env       # then add your MP_TOKEN (and MP_URL)
bun run server             # start the Mercado Pago API server (port 3001)
bun run dev                # start the Vite dev server with /api proxy (port 3000)
```

> The frontend proxies `/api` → `http://localhost:3001` in development.

### Mercado Pago

- Create a paid application at https://www.mercadopago.com/developers and copy an **access token** (`MP_TOKEN`).
- `MP_URL` must be a publicly reachable URL for webhook notifications (or rely on client polling, which the app also does).
- Payment status is polled every ~2.5s; on `approved` the purchased numbers are reserved.

## Commands

```bash
bun run dev       # dev server (port 3000)
bun run server    # Mercado Pago API (port 3001)
bun run build     # type-check + production build
bun run preview   # preview production build
```

## Architecture

- `src/main.ts` — entry point; mounts the right overlay per route (`/`, `/admin`, `/me`, `/withdraw`)
- `src/ui/overlay.ts` — main buying UI (number grid, buy bar, PIX payment modal)
- `src/ui/admin.ts` — admin page (create/replace the single raffle)
- `src/ui/mepage.ts` — "My raffles" page
- `src/ui/withdraw.ts` — prize withdrawal page (PIX key)
- `src/api.ts` — typed API client (raffle, payments, claim, withdraw)
- `src/store.ts` — shared language state + subscribers
- `src/i18n.ts` — EN/PT-BR translations
- `src/ui/footer.ts` — footer (trust/security/foundation links)
- `server/index.ts` — HTTP server (payments, webhooks, order reconciliation, draw notifications)
- `server/startup-checks.ts` — fail-fast boot checks (email + Mercado Pago)
- `server/raffle.ts` — single-raffle lifecycle (holds, sales, auto-draw, archive)
- `server/payments.ts` — Mercado Pago wrapper (PIX create, status, refunds)
- `server/email.ts` — Brevo API / Gmail SMTP delivery
- `server/storage.ts` — users + archived history
- `server/db.ts` — Turso KV persistence

The frontend is plain DOM (no framework). The backend is a dependency-light `node:http` server that runs on Bun locally or Node via `tsx`; payments and emails round-trip through it.

## Deploying on Render (separate frontend + backend)

Two independent Render services:

| Service   | Type        | What it runs                            |
|-----------|-------------|-----------------------------------------|
| `rifa-api`| Node web    | Backend (`server/index.ts`, port 3001)  |
| `rifa-web`| Static site | Built `dist/` SPA (frontend only)       |

A `render.yaml` blueprint is included — create a new Render **Blueprint**, select this repo, and Render provisions both services (no Docker).

### 1. Backend (`rifa-api`)
- Runs as a plain **Node** web service (via `tsx`); no Docker.
- Set in the Render dashboard under *Environment*:
  - `MP_TOKEN` → your Mercado Pago access token
  - `ADMIN_PASSWORD` → admin password
  - `HOST` → the **frontend** domain, e.g. `rifa-web.onrender.com` (used to build winner claim links and the "my raffles" links in emails). If unset, `CORS_ORIGIN` is used as a fallback; if neither is set the server warns at startup and emails link to `http://localhost:3000`.
  - `CORS_ORIGIN` → the **frontend** origin, e.g. `https://rifa-web.onrender.com` (must be an exact origin, not `*`, when deploying apart)
  - `MP_URL` → `https://rifa-api.onrender.com/api/webhooks` (reachable HTTPS endpoint)
  - `EMAIL` / `EMAIL_FROM` — sender address (verify it in Brevo)
  - `BREVO_API_KEY` — required on Render **free** tier (SMTP ports 25/465/587 are blocked there). SMTP (`EMAIL_P`) only works locally / on paid instances.
  - `ORDER_TTL_MINUTES` — optional; how long a pending PIX order stays before its number holds are released and the order is dropped (default `30`). A payment approved after that is auto-refunded since it can no longer be fulfilled.
  - `RAFFLE_DAYS` — optional; how long a raffle runs before its scheduled draw date (default `6`). The draw fires when the raffle sells out **or** when this deadline is reached, whichever comes first.
- `PORT` defaults to `3001`; Render injects its own `PORT` if you keep it synced.
- Local Node run (no Bun): `npm run server:node`

> All state (current raffle, sales, users, history, pending PIX orders) lives in **Turso**, a remote libSQL database — the server refuses to start without `TURSO_DATABASE_URL` (alias `TURSO_URL`), so there is no local file storage and redeploys keep their data.

### 2. Frontend (`rifa-web`)
- Static site; build command uses `bun install && bun run build:web`.
- The crucial setting is the build-time env var:
  - `VITE_API_URL` → the backend origin, e.g. `https://rifa-api.onrender.com`
- The app reads `VITE_API_URL` at build time and issues every API call to
  `https://<VITE_API_URL>/api/…`. The background banner shows an **Online / Offline / Connecting…** spinner based on live health checks against that API.
- Web content is fully static; all state (raffle, sales, winner) is fetched from the API.

### Cross-origin & routing notes
- The API already returns `Access-Control-Allow-Origin` on every response and answers `OPTIONS` preflight; set `CORS_ORIGIN` to your exact frontend origin.
- The app routes live at `/`, `/admin`, `/me`, and `/withdraw`. Static hosts usually serve `/` only, so deep links to `/admin`, `/me`, `/withdraw` may 404 unless SPA fallback is enabled. On Render, point those paths to `index.html` (or reach `/admin` from the root). The claim emails link to the frontend at `/withdraw?token=…` — make sure that path serves.

### Local (unchanged)
```bash
bun install
cp .env.example .env
bun run server        # API on :3001 (Bun), or `npm run server:node` for Node
bun run dev           # SPA on :3000 (proxies /api)
```