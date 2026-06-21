# How To Run Conjure

> Once it's running, see **[USING_CONJURE.md](USING_CONJURE.md)** for the
> everyday flow: where generated code goes, how Conjure auto-applies it to the
> browser, the one-time "Allow user scripts" toggle, and how session
> persistence works.

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

Redis is optional for first local testing because the store includes an in-memory fallback. For the intended full build (persistent conversations, sandbox cache, job streams), run Redis at:

```env
REDIS_URL=redis://127.0.0.1:6379/0
```

> On Windows, use `127.0.0.1` rather than `localhost`: the async Redis client
> resolves `localhost` to IPv6 (`::1`) and times out against the Docker
> container, which only publishes on IPv4.

## 9. Run Redis With Docker (recommended, reproducible)

The repo ships a `docker-compose.yml` pinned to `redis:7-alpine` with disk
persistence. This is the easiest way for everyone on the team to run an
identical Redis — the setup lives in the repo, so there is nothing to configure
per machine beyond installing Docker once.

### First-time setup (each machine, including your teammate's)

1. Install Docker Desktop (Windows):

   ```powershell
   winget install Docker.DockerDesktop
   ```

   Launch Docker Desktop once and let it finish first-run setup (it uses WSL2).
   A sign-out/in (or reboot) puts the `docker` CLI on your PATH permanently.

2. From the repo root, start Redis:

   ```powershell
   docker compose up -d
   docker compose ps        # conjure-redis should be "healthy"
   ```

3. Verify it responds:

   ```powershell
   docker exec conjure-redis redis-cli ping     # -> PONG
   ```

`.env` already points at it (`REDIS_URL=redis://localhost:6379/0`), so no
further config is needed.

### Your teammate's steps (later)

Same three commands after they `git pull` — the committed `docker-compose.yml`
gives them a byte-identical Redis:

```powershell
winget install Docker.DockerDesktop   # one time
docker compose up -d
docker exec conjure-redis redis-cli ping
```

### Confirm the backend actually connects

With the venv active and Redis up, temporarily disable the in-memory fallback so
a bad connection can't hide:

```powershell
$env:CONJURE_REDIS_FALLBACK="false"
python -c "import asyncio; from backend.utils.store import create_store; print(type(asyncio.run(create_store())).__name__)"
```

- `RedisStore` -> connected to the Docker container.
- `InMemoryStore` or a `ConnectionError` -> not connected (check `docker compose ps`).

Conversations, messages, and agent memory now persist in Redis across backend
restarts. Inspect them with:

```powershell
docker exec conjure-redis redis-cli keys '*'
```

### Everyday Docker commands

| Command | Effect |
| --- | --- |
| `docker compose up -d` | start Redis in the background |
| `docker compose ps` | show status/health |
| `docker compose down` | stop Redis (data is kept in the volume) |
| `docker compose down -v` | stop Redis and wipe all data |

> PATH note: in a brand-new terminal before your next sign-in, if `docker`
> errors with `docker-credential-desktop ... not found`, run once:
> `$env:PATH = "$env:ProgramFiles\Docker\Docker\resources\bin;$env:PATH"`.

