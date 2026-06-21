# How To Run Conjure

Run these commands from the repo root:

```powershell
cd D:\Documents\Code\2026\aihacks\AIHACKS2026
```

## 1. Create Local Env

```powershell
Copy-Item .env.example .env
```

For a first test without API keys, keep this in `.env`:

```env
CONJURE_DEMO_MODE=true
```

This lets the backend run in demo mode without Anthropic or Browserbase credentials.

## 2. Install Backend Dependencies

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r .\backend\requirements.txt
python -m playwright install chromium
```

## 3. Install Extension Dependencies

```powershell
npm --prefix conjure-extension install
```

## 4. Run Tests

```powershell
npm run test
python -B -m unittest backend.tests.test_store backend.tests.test_memory backend.tests.test_extension_validator backend.tests.test_sandbox
```

## 5. Start The Backend

```powershell
npm run dev:backend
```

In another terminal, check the health endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "conjure-backend"
}
```

## 6. Build And Load The Chrome Extension

```powershell
npm run build:extension
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `D:\Documents\Code\2026\aihacks\AIHACKS2026\conjure-extension\dist`
5. Click the Conjure extension icon

The side panel should open. Type a prompt. In demo mode, the backend should stream a response and create a note under `demo_code/local-demo/`.

## 7. Test Real Claude Generation

Edit `.env`:

```env
CONJURE_DEMO_MODE=false
ANTHROPIC_API_KEY=your_key_here
```

Restart the backend after changing `.env`.

Keep Anthropic and other private keys server-side only. Do not put private keys in any `VITE_*` variable because those are bundled into the Chrome extension.

## 8. Enable Full Sandbox Mode

Add these values to `.env` when available:

```env
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
SIMULAR_API_KEY=
SENTRY_DSN=
```

Redis is optional for first local testing because the generated store includes an in-memory fallback. For the intended full build, run Redis at:

```env
REDIS_URL=redis://localhost:6379/0
```

