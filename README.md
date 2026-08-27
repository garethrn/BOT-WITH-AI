# BOT-WITH-AI

This repository now contains the **MY WHATSAPP BOT** build with added AI-oriented dashboard features.

## What was added

- Base WhatsApp bot server copied from `garethrn/my-whatsapp-bot`
- Dashboard at `/dashboard`
- Upload/import section for WhatsApp backup files so the bot can learn response rules
- Teaching section to provide guidance for how the bot and OpenAI should answer
- OpenAI response generation fallback using dashboard direction and imported learning rules
- Auto-learning support for WhatsApp chat export format using your name in the transcript
- "Connect to Meta later" section to save future legal WhatsApp Business integration details

## Run

```bash
npm install
npm start
```

Optional security: set `ADMIN_API_TOKEN` and provide it in dashboard/API via `x-admin-token`.
To enable OpenAI responses, set `OPENAI_API_KEY`.

## Full beginner ("dummies") install guide

If you are new to Railway and bots, follow these exact steps.

### A) Accounts you need first
1. GitHub account
2. Railway account
3. OpenAI account (for API key)
4. WhatsApp phone account
5. Optional Gmail account (only if you want QR codes emailed to you)

### B) Copy this repository
1. Open `garethrn/BOT-WITH-AI` on GitHub.
2. Fork or use your own copy.
3. Push any changes before deploying.

### C) Create Railway app
1. Login to Railway.
2. Click **New Project**.
3. Click **Deploy from GitHub Repo**.
4. Select this repo.
5. Wait for Railway to create the service.

### D) Add permanent storage (required)
1. In Railway project, add a **Volume**.
2. Mount path must be: `/app/storage`.
3. Keep this volume attached forever.

Without this volume, login/auth sessions and learned AI data can be lost after restarts.

### E) Create OpenAI API key
1. Login to OpenAI platform.
2. Go to API keys page.
3. Create a new secret key.
4. Copy it immediately.
5. Save into Railway variable: `OPENAI_API_KEY`.

### F) Create Google App Password (for QR email) — optional
Use this only if you want email QR delivery.

1. Login to your Google account.
2. Open **Manage your Google Account**.
3. Go to **Security**.
4. Turn on **2-Step Verification** (required by Google before app passwords appear).
5. In Security, open **App passwords**.
6. Choose app name (for example: `BotWithAI Railway`).
7. Click **Create**.
8. Copy the generated 16-character app password.
9. Put your Gmail address in `EMAIL_USER`.
10. Put the app password in `EMAIL_PASS`.

Do not use your normal Gmail password in `EMAIL_PASS`.

### G) Add Railway variables (copy/paste)
Set these in Railway → Service → **Variables**:

```env
ADMIN_JID=1234567890@s.whatsapp.net
ADMIN_API_TOKEN=change-this-to-a-long-random-secret
AI_DATA_FILE=/app/storage/ai-learning.json
OPENAI_API_KEY=your-openai-key
OPENAI_MODEL=gpt-4o-mini
EMAIL_USER=yourgmail@gmail.com
EMAIL_PASS=your-16-char-google-app-password
```

Notes:
- `EMAIL_USER` and `EMAIL_PASS` can be blank if you do not need email QR.
- `PORT` is not required (Railway sets it automatically).

### H) Deploy
1. Trigger deploy (or wait for auto deploy).
2. Open deployment logs.
3. Confirm startup messages appear.

### I) Connect WhatsApp
1. Open: `https://your-domain/qr`
2. Scan with WhatsApp on your phone.
3. Wait for connection success in logs/dashboard status.

### J) Open full dashboard
1. Open: `https://your-domain/dashboard`
2. Paste `ADMIN_API_TOKEN` in token field (if enabled).
3. Use sections:
   - Upload backups
   - Teach AI behavior
   - Save Meta-later details
   - View learned data summary (backups, rules, teachings)

### K) Train OpenAI using your chats
1. Export WhatsApp chat from your phone.
2. Upload file in dashboard.
3. Add `trainerName` exactly matching your chat name for auto-learning.
4. Save teaching instructions in dashboard.
5. OpenAI responses will follow those rules + directions.

### L) Quick troubleshooting
- **401 Unauthorized on dashboard API**: token is missing/wrong (`ADMIN_API_TOKEN`).
- **No OpenAI replies**: missing/invalid `OPENAI_API_KEY`.
- **Data disappears after restart**: volume missing or wrong mount path.
- **No QR email**: Gmail app password not created correctly.

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
2. Optional: set **Your name in the chat export** so the bot learns from your own replies in transcript format.
3. Add training lines in backup content such as:
   - `hello => Hi! How can I help?`
   - `Q:delivery|A:Delivery takes 2 days`
4. You can also upload WhatsApp export style lines such as:
   - `12/1/25, 9:10 PM - Customer: Hi`
   - `12/1/25, 9:11 PM - Gareth: Hello! How can I help?`
5. Submit upload to import rules into bot learning storage.

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

`POST /api/ai/upload-backup` accepts multipart fields:
- `backup` (file, required)
- `trainerName` (optional, used to extract your responses from WhatsApp transcript exports)

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
- `POST /api/ai/upload-backup` – upload backup file (`backup`) and optional `trainerName`
- `POST /api/ai/teach` – save teaching instructions
- `POST /api/meta/connect-later` – store future Meta connection intent
