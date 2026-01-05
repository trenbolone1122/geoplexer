# Local BYOK Guide

## Requirements

- Docker (recommended)
- Or: Bun + Node 20+ for local dev

## Environment variables

Create the two `.env` files from the examples:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

### API (`apps/api/.env`)

Required:
- `PERPLEXITY_API_KEY`
- `SERPER_API_KEY`

Optional:
- `CORS_ORIGIN` (default allows all)
- `PORT` (default 3000)
- `PERPLEXITY_MODEL` (default `sonar-reasoning-pro`)
- `PERPLEXITY_TIMEOUT_MS` (default 25000)
- `PERPLEXITY_MAX_TOKENS` (default 2000)
- `SERPER_TIMEOUT_MS` (default 10000)
- `SERPER_MAPS_ZOOM` (default 16)
- `IMAGE_PROXY_TIMEOUT_MS` (default 8000)

### Web (`apps/web/.env`)

Required:
- `VITE_MAPBOX_TOKEN`

Recommended:
- `VITE_API_BASE_URL=http://localhost:3000`

## Run with Docker

```bash
docker compose up --build
```

- Web: http://localhost:5173
- API: http://localhost:3000

## Run locally without Docker

API:

```bash
cd apps/api
bun install
bun run dev
```

Web:

```bash
cd apps/web
npm install
npm run dev
```

Open http://localhost:5173

## Troubleshooting

- "Missing VITE_MAPBOX_TOKEN" means the web env is not set.
- "SERPER_API_KEY is not configured" means places will be empty.
- If the browser can’t reach the API, confirm `VITE_API_BASE_URL` and `CORS_ORIGIN`.
