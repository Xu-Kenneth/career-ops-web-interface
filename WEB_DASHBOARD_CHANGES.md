# Career-Ops Web Dashboard — Change Log

## What was built

A local web dashboard for Career-Ops that runs alongside Claude Code and lets you execute all `/career-ops` commands from a browser UI with live streaming output.

**Run it:**
```bash
node web-dashboard.mjs
# or
npm run dashboard:web
```
Opens at **http://localhost:3333**

---

## Files added / changed

| File | Change |
|------|--------|
| `web-dashboard.mjs` | New — HTTP server (zero dependencies, Node.js built-ins only) |
| `dashboard/web/index.html` | New — Full SPA frontend |
| `package.json` | Added `"dashboard:web": "node web-dashboard.mjs"` script |
| `WEB_DASHBOARD_CHANGES.md` | This file |

---

## Architecture

### Server (`web-dashboard.mjs`)

Pure Node.js `http` module — no npm dependencies.

**Job runner:**
- `POST /api/run` — spawns `claude -p "[message]"` from the career-ops directory (picks up `CLAUDE.md` automatically). On Windows uses `cmd /c claude` since the binary is a `.cmd` wrapper. Returns a `jobId`.
- `GET /api/stream/:id` — Server-Sent Events (SSE) stream of stdout/stderr for the job.
- `POST /api/kill/:id` — Kills a running job (`SIGTERM` + `taskkill /f /t` on Windows).

**Data APIs:**
- `GET /api/stats` — Stats for dashboard (totals, avg score, breakdown).
- `GET /api/applications` — Parse `data/applications.md` into JSON.
- `PUT /api/applications/:num/status` — Inline status updates.
- `GET /api/pipeline` — Parse `data/pipeline.md`.
- `POST /api/pipeline/add` — Append a URL to the inbox.
- `GET /api/reports` — List `reports/` directory.
- `GET /api/reports/:filename` — Read a report file.
- `GET /api/cv` — Read `cv.md`.
- `GET /api/profile` — Read `config/profile.yml`.
- `POST /api/jd` — Save text to `jds/filename.md`.

**JD text handling:** When a run request includes `jdText`, the server saves it to `jds/temp-TIMESTAMP.md` and converts it to a `local:jds/temp-*.md` reference before building the claude command. This is consistent with how career-ops handles local JD files.

---

### Frontend (`dashboard/web/index.html`)

Single-file SPA. No frameworks, no build step, no CDN dependencies — works fully offline.

#### Views

| View | Description |
|------|-------------|
| **Dashboard** | Stats cards, status donut chart, recent applications |
| **Run Command** | All 13 career-ops commands as clickable cards with input forms + live terminal |
| **Chat** | Free-form chat interface backed by `claude -p` with career-ops context |
| **Applications** | Searchable/sortable table, inline status dropdowns that save on change |
| **Pipeline Inbox** | Pending/processed URLs, add-URL form, "Run Pipeline" shortcut button |
| **Reports** | Sidebar list + markdown viewer |
| **Add JD** | Drag-and-drop or paste — save to `jds/`, evaluate directly, or add to pipeline |
| **My CV** | Rendered `cv.md` |
| **Profile** | Raw `config/profile.yml` |

#### Command execution (Run Command view)

All 13 commands are wired up with appropriate input forms:

| Command | Inputs collected |
|---------|-----------------|
| Evaluate Offer | URL or JD text |
| Process Pipeline | None |
| Scan Portals | None |
| Application Tracker | None |
| Compare Offers | Optional report numbers/companies |
| Generate CV/PDF | Optional job URL |
| Deep Research | Company name (required) |
| LinkedIn Outreach | Company (required), role (optional) |
| Apply Assistant | Application URL (required) |
| Interview Prep | Company name (required) |
| Evaluate Training | URL or course description |
| Evaluate Project | Project description (required) |
| Batch Evaluate | None |

Clicking **Run Command**:
1. Collects form inputs, validates required fields
2. POSTs to `/api/run` → spawns `claude -p "/career-ops [mode] [args]"` in career-ops directory
3. Opens SSE stream → output appears live in the terminal panel
4. **Stop** button kills the process mid-run
5. ANSI escape codes are stripped before display

#### Chat view

- Type any message or `/career-ops` command
- Sends to `claude -p "[message]"` from career-ops directory → CLAUDE.md context is always active
- Response streams token-by-token into a chat bubble
- Suggestion chips for common commands
- `Enter` to send, `Shift+Enter` for newline
- Markdown rendered in responses

---

## Known limitations

- Chat is single-turn per message (no persistent session between messages). The career-ops CLAUDE.md context provides continuity for most use cases.
- Commands that require Playwright (e.g., `apply`, `scan`) will use the same Node.js process — Playwright must be installed (`npx playwright install`).
- Long-running commands (batch, pipeline) may produce large terminal output — the terminal auto-scrolls.
- On Windows, process killing uses `taskkill /f /t` which may leave orphaned child processes in rare cases.
