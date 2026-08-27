# BOT-WITH-AI

This repository now contains the **MY WHATSAPP BOT** build with added AI-oriented dashboard features.

## What was added

- Base WhatsApp bot server copied from `garethrn/my-whatsapp-bot`
- Dashboard at `/dashboard`
- Upload/import section for WhatsApp backup files so the bot can learn response rules
- Teaching section to provide guidance for how the bot should answer
- "Connect to Meta later" section to save future legal WhatsApp Business integration details

## Run

```bash
npm install
npm start
```

Optional security: set `ADMIN_API_TOKEN` and provide it in dashboard/API via `x-admin-token`.

## Dashboard and API

- `GET /dashboard` – web dashboard
- `GET /qr` – current login QR (when available)
- `GET /api/dashboard/state` – bot + learning state
- `POST /api/ai/upload-backup` – upload backup file (`backup` field)
- `POST /api/ai/teach` – save teaching instructions
- `POST /api/meta/connect-later` – store future Meta connection intent
