# conjure

`conjure` is a self-building browser agent. A local Chrome extension gathers browser context and hosts the chat UI; a FastAPI backend routes work to the configured coding provider, tracks progress, stores conversation/session state, and reports finished agent session or PR links back to the user.

The architecture source of truth is [MASTER_DESIGN_DOC.md](MASTER_DESIGN_DOC.md).

## Expected Layout

```text
backend/            FastAPI agent service, Redis store, sandbox/test/heal loop
conjure-extension/   Vite + React + CRXJS MV3 Chrome extension
tests/              repo-level smoke and integration checks
.env.example        local configuration template, no real secrets
```

## Configuration

Create a local env file from the template:

```powershell
Copy-Item .env.example .env
```

Fill in real values for the selected coding provider, Redis, Browserbase, Simular, and Sentry in `.env`. Do not commit secrets. The extension reads only `VITE_` values at build time, so do not put private API keys behind `VITE_` names.

Required config groups:

- Agent provider: `CONJURE_AGENT_PROVIDER=devin` for Devin cloud sessions, `CONJURE_AGENT_PROVIDER=claude` for the Claude local tool loop, or `CONJURE_AGENT_PROVIDER=nemotron` for the NVIDIA Nemotron local tool loop
- Devin: `DEVIN_API_KEY`, `DEVIN_ORG_ID`, API base URL, agent mode, repositories, branch, and polling settings
- Claude: `ANTHROPIC_API_KEY` and `CONJURE_ANTHROPIC_MODEL`
- Nemotron: `NVIDIA_API_KEY`, `NVIDIA_MODEL`, and optional `NVIDIA_API_BASE_URL` for self-hosted NIM
- Redis: `REDIS_URL`, `REDIS_NAMESPACE`, sandbox cache TTL
- Browserbase: API key, project ID, session settings
- Simular: API key and optional endpoint/model override
- Sentry: backend DSN, sandbox DSN, environment, trace sample rate
- Backend URL: HTTP and WebSocket base URLs
- Extension config: Vite-exposed backend URLs, extension environment, public Sentry DSN

## Backend Setup

Run these after the backend worker lands `backend/pyproject.toml` and `backend/main.py`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r .\backend\requirements.txt
python -m playwright install chromium
npm run dev:backend
```

The backend should read `.env`, connect to Redis, expose the WebSocket contract from the design doc, and route each Conjure conversation to the selected provider. Demo mode simulates provider progress without external credentials.

Nemotron uses NVIDIA's LangChain `ChatNVIDIA` integration and the same local backend tool loop as Claude. For hosted API Catalog usage, set `CONJURE_AGENT_PROVIDER=nemotron`, `CONJURE_DEMO_MODE=false`, `NVIDIA_API_KEY`, and optionally override `NVIDIA_MODEL`. For local NIM later, set `NVIDIA_API_BASE_URL=http://localhost:8000/v1`.

## Extension Setup

Run these after the extension worker lands `conjure-extension/package.json`:

```powershell
npm --prefix conjure-extension install
npm run dev:extension
```

For manual Chrome testing, build the extension and load the unpacked output directory from Chrome's Extensions page. Keep Devin, Claude, Nemotron, and other provider keys server-side; the extension should use `VITE_BACKEND_URL` and `VITE_BACKEND_WS_URL` only.

## Dev Commands

```powershell
npm run dev:backend       # FastAPI on 127.0.0.1:8000
npm run dev:extension     # Vite/CRXJS extension dev server
npm run build:extension   # extension production build
npm run test              # root smoke checks
npm run test:smoke        # same smoke checks, explicit name
npm run test:backend-smoke
```

`npm run test:backend-smoke` is opt-in. Set `CONJURE_SMOKE_BACKEND_URL` to a running backend URL when the service exists; without it, the test skips.

## Test Commands

The current scaffold uses stdlib `unittest` so it works before backend and extension dependencies exist:

```powershell
python -m unittest discover -s tests/smoke
```

Pytest is also configured for future workers:

```powershell
python -m pytest
```

When backend and extension implementations arrive, add focused tests under `tests/` or `e2e/` without importing generated extension projects from `demo_code/`.

## Integration Notes

- Redis should hold projects, conversations, memory rules, Devin session mappings, sandbox result cache entries, and sandbox job streams.
- Browserbase owns disposable Chrome sessions and replay/screenshot capture.
- Simular owns autonomous functional, crash, and security passes against the Browserbase session.
- Sentry should use separate environments or projects for backend, extension, and sandbox crashes.
- Generated extension artifacts belong in `demo_code/` and are ignored by Git.
