# CLAUDE.md — conjure "Find on this page" buildout

Working notes so any session can resume fast. Conjure = self-building browser agent
(FastAPI backend + Chrome MV3 side-panel extension). This file tracks the **agent
product-finder** feature.

## Branch
`feat/fetchai-agent-finder` (name is historical; feature pivoted twice — see log).

## Goal (current target)
A side-panel **"Find on this page"** box: user types e.g. `jackets under $100`, an
**off-device cloud browser** navigates/scrolls/extracts, and result **cards** (image +
title link + price + note) come back, plus a **replay link to watch it**.

## Decision log (most recent wins)
1. ASI:One (Fetch.ai) over scraped HTML — built, then replaced.
2. **AgentSpan (Orkes)** over scraped HTML — built + proven live (found jackets, dropped
   earbuds). Still in repo; now being superseded for the browsing path.
3. **NOW: off-device browsing** — don't scrape the user's local tab. Spin up a cloud
   browser that does the navigating itself.
   - **Stack: Browserbase (cloud browser) + Stagehand (AI act/extract/execute).**
   - **Navigation:** start from the **current tab URL**, agent may move/scroll, **no user
     input** beyond the task.
   - **Auth: cookie hand-off** — extension reads `chrome.cookies` for the current domain +
     URL, backend injects them into the Browserbase session (Playwright
     `context.add_cookies`) before navigating, so the cloud browser is "logged-in you".
   - **Watch it:** return the Browserbase replay/live URL.
   - AgentSpan = optional durability/observability wrapper later (Orkes prize story); not
     required for browsing.
   - Why not screenshot/vision: the DOM has the real `href`/`img src`; a screenshot
     doesn't. DOM extraction is faster + reliable. Vision = fallback only.
   - Cookie-handoff caveat: works for most sites; aggressive bot-defended sites (Amazon)
     may challenge a new cloud IP. Public pages (Amazon jacket search) are fine.

## What is built & working now (AgentSpan-over-HTML path)
- `backend/utils/agentspan_finder.py` — runs AgentSpan agent over **posted** page HTML →
  findings. Note `AgentResult.output` is `{"result": <text>, ...}` (handled).
- `POST /projects/{id}/agent-task` in `backend/main.py` — body `{task,url,text,html}` →
  `{project_id,task,url,findings}`. 400 empty task / 503 not-ready / 502 run error.
- Extension: "Find on this page" box in `conjure-extension/src/sidepanel/App.tsx`
  (`runAgentTask`), scrapes active tab, posts HTML, renders cards.
  `shared/config.ts:createAgentTaskUrl`, `shared/messages.ts:AgentFinding/AgentTaskResponse`,
  `sidepanel/styles.css:.finder-*/.finding-*`.
- `backend/utils/config.py`: `AGENTSPAN_LLM_MODEL` (default `anthropic/claude-sonnet-4-6`),
  `AGENTSPAN_SERVER_URL` (`http://localhost:6767/api`), `AGENTSPAN_MAX_RESULTS`.
- `docker-compose.yml`: `redis` + `agentspan` (`agentspan/server:latest` :6767) +
  `agentspan-postgres`. **Running now.** `.env` has `AGENTSPAN_MASTER_KEY` (dev),
  `ANTHROPIC_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`.
- Tests: `backend/tests/test_agentspan_finder.py`, `test_agent_task_endpoint.py` → **52 pass**.
- Proven Browserbase pattern already in repo: `backend/utils/sandbox.py`
  (`Browserbase(api_key)` → `sessions.create(project_id)` → playwright
  `connect_over_cdp(connect_url)` → screenshot + `replay_url`).

## BUILD PLAN / TODO (off-device pivot)
1. `pip install stagehand` in `.venv`; add `stagehand` to `backend/requirements.txt`.
2. **`backend/utils/browser_agent.py`** (new, async):
   - `BrowserAgentSettings(browserbase_api_key, browserbase_project_id, model, model_api_key, max_results)`.
   - `find_items_remote(task, start_url, cookies)`:
     - `AsyncStagehand(browserbase_api_key, model_api_key=ANTHROPIC_KEY)` → `session = await client.sessions.start(model_name="anthropic/claude-sonnet-4-6", browser={"type":"browserbase"})`.
     - Cookie hand-off: `cdp=session.data.cdp_url`; playwright `connect_over_cdp(cdp)` → `context.add_cookies(cookies)` (map chrome cookies → playwright shape).
     - `await session.navigate(url=start_url)`; 2–3 `act("scroll down to load more results")`.
     - `extract` with items schema (below). If empty → `execute` search ("find <task>, search/scroll, stay on site", max_steps≈6) then `extract` again.
     - normalize (reuse `agentspan_finder._normalize_items/_absolute/_clean`).
     - return `{findings, session_id: session.id, replay_url}`.
   - SSE consumption helper: iterate stream; `event.type=="log"` skip; `event.data.status` in {finished→result at `event.data.result`, error→raise}.
   - `BrowserAgentError`; `missing_requirement()` (browserbase keys + stagehand import + model key).
3. **`backend/main.py`**: `AgentTaskRequest` → `{task, url, cookies: list[dict]}`; route to
   `browser_agent.find_items_remote`; response adds `replay_url` + `session_id`. Decide:
   keep `agentspan_finder` as fallback or remove. Keep response `findings` shape stable.
4. **`backend/utils/config.py`**: add `browserbase_*`, browse model (reuse `ANTHROPIC_API_KEY`
   as `model_api_key`), `BROWSE_MAX_RESULTS`.
5. **Extension**:
   - Manifest: add `"cookies"` permission (host perms already broad). Find manifest
     (CRXJS — `conjure-extension/` manifest config / `vite.config`).
   - `App.tsx runAgentTask`: `chrome.cookies.getAll({url: activeTab.url})`; send
     `{task, url, cookies}`; render "▶ Watch the agent" link from `replay_url`.
   - `messages.ts`: extend `AgentTaskResponse` w/ `replay_url?`,`session_id?`; cookie type.
6. **Tests**: unit normalize + chrome→playwright cookie map + SSE result parse + endpoint
   wiring (mock `find_items_remote`). Live verify on a **public** shop (e.g.
   `https://books.toscrape.com` or `https://webscraper.io/test-sites/e-commerce/allinone`) —
   avoid Amazon bot wall for the automated check.
7. **Docs**: README + HOW_TO_RUN; `.env.example` notes (cookies handoff, model key).

## Stagehand v3 Python API (verified from browserbase/stagehand-python examples)
```python
from stagehand import AsyncStagehand   # sync: Stagehand(server="remote", ...)
async with AsyncStagehand(browserbase_api_key=BB, model_api_key=ANTHROPIC) as client:
    session = await client.sessions.start(model_name="anthropic/claude-sonnet-4-6",
                                          browser={"type": "browserbase"})
    sid = session.id
    cdp = session.data.cdp_url               # attach Playwright here for cookies
    await session.navigate(url="https://...")
    # observe/act/extract/execute → SSE streams: stream_response=True, x_stream_response="true"
    stream = await session.extract(
        instruction="find products matching: <task>",
        schema={"type":"object","properties":{"items":{"type":"array","items":{
            "type":"object","properties":{"title":{"type":"string"},"url":{"type":"string"},
            "image":{"type":"string"},"price":{"type":"string"},"note":{"type":"string"}},
            "required":["title","url"]}}},"required":["items"]},
        stream_response=True, x_stream_response="true")
    # execute = autonomous multi-step agent:
    # await session.execute(execute_options={"instruction":..., "max_steps":8},
    #   agent_config={"model":{"model_name":"anthropic/claude-opus-4-6","api_key":ANTHROPIC},"cua":False},
    #   stream_response=True, x_stream_response="true", timeout=300.0)
    await session.end()
# SSE: for event in stream: if event.type=="log": ...; elif event.data.status=="finished": result=event.data.result; elif=="error": raise
```
- `model_api_key` = `ANTHROPIC_API_KEY`. Replay URL ≈ `https://www.browserbase.com/sessions/{sid}`.
- Cookie hand-off snippet (async playwright): `b=await p.chromium.connect_over_cdp(cdp); ctx=b.contexts[0]; await ctx.add_cookies([...])`.
- chrome cookie → playwright: keep `name,value,domain,path`; map `expirationDate`→`expires`,
  `httpOnly`,`secure`,`sameSite` (chrome `no_restriction|lax|strict` → `None|Lax|Strict`).

## Run / verify
- `docker compose up -d` (redis + agentspan; Browserbase is cloud — no container).
  Dashboard: AgentSpan http://localhost:6767 ; Browserbase sessions at browserbase.com.
- Backend: `.venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8237`
  ⚠ stale uvicorns occupy :8000 and :8001 — use a fresh port and confirm bind (no `Errno 10048`).
- Tests: `.venv/Scripts/python.exe -m pytest backend/tests -q`
- Extension typecheck: `npm --prefix conjure-extension run typecheck`
- Endpoint smoke (after pivot): `POST http://127.0.0.1:8237/projects/demo/agent-task`
  `{"task":"...","url":"https://...","cookies":[]}`.

## Gotchas
- Windows stdout is cp1252 → emoji/`→` crash prints; write to a UTF-8 file and Read it.
- `.env` is gitignored (good); never commit secrets. Don't commit `stagehand_examples.txt`.
- Browserbase free tier has concurrent-session limits; `session.end()` always.
- Don't commit unless asked. End commit msgs with the Co-Authored-By trailer.
