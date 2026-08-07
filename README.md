# Golden Lion Rifa

A 3D lion-themed raffle game (Rifa) built with **Bun**, **Three.js** (3D rendering) and **Phaser 4** (UI/HUD). Bilingual — English and Portuguese — with **Mercado Pago PIX payments**.

## Features

- 3D stage with a stylized golden lion, a spinning, raffle drum and confetti
- Create a raffle (title, prize, number of tickets, price, currency)
- Buy numbers via the **Mercado Pago PIX payment gateway** (QR code displayed, status polled, tickets reserved on approval)
- Draw a winner with a live spin + drum animation
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

- `src/three/world.ts` — Three.js scene (lion, drum, lights, confetti)
- `src/phaser/ui.ts` — Phaser 4 UI (setup, number grid, stats, draw, payment modal)
- `src/api.ts` — typed Mercado Pago API client (create payment, poll status)
- `src/store.ts` — shared reactive state + event emitter
- `src/i18n.ts` — EN/PT-BR translations
- `server/index.ts` — Bun HTTP server (payments, webhooks, orders)
- `server/payments.ts` — Mercado Pago SDK wrapper (PIX)

Phaser renders a transparent UI over the Three.js canvas; they communicate through the shared `store`, and payments round-trip through the Bun backend.

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
  - `PUBLIC_HOST` → the **frontend** domain, e.g. `rifa-web.onrender.com` (used to build winner claim links)
  - `CORS_ORIGIN` → the **frontend** origin, e.g. `https://rifa-web.onrender.com` (must be an exact origin, not `*`, when deploying apart)
  - `MP_URL` → `https://rifa-api.onrender.com/api/webhooks` (reachable HTTPS endpoint)
  - `EMAIL_USER` / `EMAIL_PASS` / `EMAIL_FROM` (Gmail app password) as needed
- `PORT` defaults to `3001`; Render injects its own `PORT` if you keep it synced.
- Local Node run (no Bun): `npm run server:node`

> State (`server/data/raffle.json`, `users.json`, `history.json`) lives on the container's ephemeral disk and resets on redeploys across instances. For durable storage on a paid plan, attach a persistent **Disk** to `rifa-api` mounted at `/app/server/data`.

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