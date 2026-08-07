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
cp .env.example .env       # then add your MP_ACCESS_TOKEN (and MP_NOTIFICATION_URL)
bun run server             # start the Mercado Pago API server (port 3001)
bun run dev                # start the Vite dev server with /api proxy (port 3000)
```

> The frontend proxies `/api` → `http://localhost:3001` in development.

### Mercado Pago

- Create a paid application at https://www.mercadopago.com/developers and copy an **access token** (`MP_ACCESS_TOKEN`).
- `MP_NOTIFICATION_URL` must be a publicly reachable URL for webhook notifications (or rely on client polling, which the app also does).
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