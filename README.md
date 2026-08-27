# BOT-WITH-AI

This repository now contains the **MY WHATSAPP BOT** build with added AI-oriented dashboard features.

## What was added

- Base WhatsApp bot server copied from `garethrn/my-whatsapp-bot`
- Dashboard at `/dashboard`
- Upload/import section for WhatsApp backup files so the bot can learn response rules
- Teaching section to provide guidance for how the bot and OpenAI should answer
- OpenAI response generation fallback using dashboard direction and imported learning rules
- "Connect to Meta later" section to save future legal WhatsApp Business integration details

## Run

```bash
npm install
npm start
```

Optional security: set `ADMIN_API_TOKEN` and provide it in dashboard/API via `x-admin-token`.
To enable OpenAI responses, set `OPENAI_API_KEY`.

## Railway deployment and implementation guide (step-by-step)

### 1) Prerequisites
- GitHub account with access to `garethrn/BOT-WITH-AI`
- Railway account
- WhatsApp account/phone for QR scan
- Optional Gmail app password for QR email delivery

### 2) Prepare the repository
1. Push your latest code to GitHub.
2. In local clone, verify startup:
   ```bash
   npm install
   npm start
   ```
3. Stop the process after startup verification.

### 3) Create a Railway project
1. In Railway, click **New Project**.
2. Choose **Deploy from GitHub Repo**.
3. Select `garethrn/BOT-WITH-AI`.
4. Railway will use `nixpacks.toml` and run `node index.js`.

### 4) Add persistent storage (required)
1. In Railway project, create a **Volume**.
2. Mount it to this service (recommended mount path: `/app/storage`).
3. Keep this volume attached permanently.

Why this is required:
- WhatsApp auth session files are stored in `storage/auth_info`
- Imported backups are stored in `storage/backups`
- AI learning data is stored in `storage/ai-learning.json`

### 5) Set environment variables in Railway
Set these in service **Variables**:

- `ADMIN_JID=1234567890@s.whatsapp.net` (replace with your admin WhatsApp JID)
- `ADMIN_API_TOKEN=<strong-random-token>` (recommended for production)
- `AI_DATA_FILE=/app/storage/ai-learning.json` (recommended with Railway volume)
- `OPENAI_API_KEY=<your-openai-api-key>` (required for OpenAI replies)
- `OPENAI_MODEL=gpt-4o-mini` (optional, default shown)
- `EMAIL_USER=<optional-gmail-address>` (optional)
- `EMAIL_PASS=<optional-gmail-app-password>` (optional)
- `PORT` is optional (Railway injects port automatically)

You can copy from `.env.example` and fill real values.

### 6) Deploy
1. Trigger deployment (auto-triggers when connected to GitHub or after push).
2. Wait until deployment status is successful.

### 7) Check logs
In Railway logs, confirm startup messages similar to:
- web server listening
- dashboard available
- initializing WhatsApp engine

### 8) Connect WhatsApp
1. Open your Railway public URL + `/qr`
2. Scan QR with your WhatsApp phone.
3. Wait for bot connection to complete.

### 9) Open the dashboard
1. Open your Railway public URL + `/dashboard`
2. If `ADMIN_API_TOKEN` is set, enter token in dashboard token field.

### 10) Implement AI learning from backups
1. In dashboard **Import WhatsApp Backups for Learning**, upload `.txt`, `.csv`, or `.json`.
2. Add training lines in backup content such as:
   - `hello => Hi! How can I help?`
   - `Q:delivery|A:Delivery takes 2 days`
3. Submit upload to import rules into bot learning storage.

### 11) Teach response behavior
1. In dashboard **Teach AI Behavior**, enter instruction text.
2. Save teaching to persist behavior guidance.
3. OpenAI uses this dashboard teaching plus imported backup rules as direction for generated replies.

### 12) Set up future Meta legal integration option
1. In dashboard **Meta Legal Integration (Later)**, enter:
   - Meta Business Account ID
   - Phone Number ID
   - Notes
2. Save to store future migration intent for official Meta setup.

### 13) Validate endpoints after deploy
- `GET /dashboard`
- `GET /qr`
- `GET /api/dashboard/state` (include `x-admin-token` when token is enabled)
- `POST /api/ai/upload-backup`
- `POST /api/ai/teach`
- `POST /api/meta/connect-later`

Example quick checks:
```bash
curl -i https://<your-railway-domain>/dashboard
curl -i https://<your-railway-domain>/qr
curl -i -H "x-admin-token: <token>" https://<your-railway-domain>/api/dashboard/state
```

`/api/dashboard/state` includes an `openai` object showing whether OpenAI is enabled and which model is active.

### 14) Operational notes
- Keep `ADMIN_API_TOKEN` enabled in production.
- Keep Railway volume mounted to avoid losing auth and learning state.
- Redeploy by pushing commits to GitHub.
- If disconnected, check logs and re-open `/qr` to re-link.

### 15) Go-live checklist
- Deployment healthy
- Volume mounted
- Environment variables set
- QR scanned and connected
- Dashboard accessible
- Backup import tested
- Teaching save tested
- API token verification tested

## Dashboard and API

- `GET /dashboard` – web dashboard
- `GET /qr` – current login QR (when available)
- `GET /api/dashboard/state` – bot + learning state
- `POST /api/ai/upload-backup` – upload backup file (`backup` field)
- `POST /api/ai/teach` – save teaching instructions
- `POST /api/meta/connect-later` – store future Meta connection intent
