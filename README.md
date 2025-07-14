
# LP Inferno Backend

This backend scans Uniswap LP NFTs sent to the LP Inferno vault and serves a REST API.

## Endpoints

- `GET /vault-tokens?wallet=0x...` — returns tokens that a user sent to the vault
- `POST /scan` — triggers manual rescan

## Setup

```
npm install
cp .env.example .env
npm run dev
```

## Deploy

You can deploy this project to [Railway](https://railway.app), [Render](https://render.com), or a VPS.
