# CLAUDE.md

IPO allotment checker: checks the allotment status of client PANs against registrar websites, stores results, and reports on them.
Live at **https://allotment.investoyard.com** (IIS reverse proxy → Node app on `127.0.0.1:3100`).
Repo: https://github.com/investoyard/Allotment-Check-Web (branch `main`; commit and push when the user asks).

See [PLAN.md](PLAN.md) for history and registrar notes, and [README.md](README.md) for user-facing setup and usage.

## Stack
- Node 24 + TypeScript (ESM, run with `tsx`, no build step), Fastify 5, Prisma 6, PostgreSQL, ExcelJS, Zod 4, Vitest.
- UI: a single file, `public/index.html` (vanilla JS, inline SVG icons, light theme, no framework and no CDN, so it works offline).
- Database: database and user `allotment`, on the Investoyard Postgres server (`D:\Investoyard\.tools\pgsql`, port **5433**). Its superuser is `postgres`; don't touch Investoyard's own databases.
- Python is not installed on this server. Use Node.

## Commands
```
npm test              # unit tests (fast, no DB)
npm run test:e2e      # full flow against real Postgres, in a throwaway schema e2e_test, with fake registrars
npm run typecheck
npm run registrar -- ipos <mufg|kfin|bigshare|skyline|purva|maashitla>   # live IPO list, no DB
npm run registrar -- check <registrar> <ipoId> <PAN>                      # sends a real PAN: ask the user first
npm run create-admin -- <username> "<name>"                               # create or reset an admin
npx prisma migrate dev --name <x> --create-only                           # new migration (then deploy)
```
Always run typecheck, `npm test` and `npm run test:e2e` before committing. Also syntax-check the UI script: extract the `<script>` from index.html and run `node --check`.

## Layout
- `src/app.ts`: builds Fastify (`buildApp(config, { prisma, registry })`), decorates `prisma`, `vault`, `registry`, `runner`, `scheduler`. `src/server.ts` starts it.
- `src/routes/*`: one file per API area. `users` and `audit` are **admin-only**; everything else only needs a login.
- `src/registrars/*`: one adapter per registrar, implementing `RegistrarAdapter` (`listIpos`, `check`, `minDelayMs`). Shared helpers are in `http.ts` (timeouts, Retry-After, `RetryableError`), `html.ts` (layout-tolerant HTML result parser, cookie jar, captcha detection) and `xml.ts`. The list is in `index.ts`.
- `src/services/`:
  - `jobRunner.ts`: in-process queue, one per registrar. It retries transient errors and resumes after restart. Start, finish and cancel use **conditional updates**, so cancel races can't leave a job RUNNING forever.
  - `checkJobs.ts`: `createCheckJob`, shared by the API, the import flow and the scheduler.
  - `scheduler.ts`: allotment-day automation. The pure `decide()` function, plus IST hours and sample probes.
  - `reports.ts`, `excel.ts`: history, tallies, P&L and workbooks.
  - `panImport.ts`, `panDelete.ts`, `panVault.ts`: PAN import, delete, and encryption/hash/`display()`.
- `scripts/`: `install-service.ps1` (Task Scheduler task `AllotmentChecker`, runs as SYSTEM), `setup-iis.ps1`, `setup-db.ps1`/`create-db.sql`, `gen-keys.ts`.
- `iis/web.config`: HTTPS redirect, proxy to 127.0.0.1, and security headers. This folder is the IIS site's root.
- One-click files: `start-app.bat` (local dev or run) and `update-app.bat` (admin: migrate and restart the service).

## Product decisions (agreed with the user; don't reverse them without asking)
- **No PAN masking anywhere.** The full PAN shows for every user, on screen and in every export. PANs are still **encrypted at rest** (AES-256-GCM, `PAN_ENC_KEY`) with an HMAC (`PAN_HMAC_KEY`) used for lookups and uniqueness. Ciphertext must never be sent to the browser; check responses for `panEncrypted`.
- **Roles:** an OPERATOR can do everything except **Users** and **Audit log**, which are ADMIN-only. A user can't change their own role.
- **Deleting a PAN** removes it from the list and from future checks. Its `CheckResult` rows keep a snapshot (`panEncrypted`, `panMasked`, `holderName`, `clientId`, `clientName`, with `panId = null`), so reports still show the full PAN. 98 older rows from before 30 Oct 2026 have no `panEncrypted` and display masked through `vault.display()`.
- **Client groups:** a client named like its holder isn't a real group (that's what an import without a Client column produces). Hide Client columns and filters unless some row is grouped; see `lib/names.ts` and `isGroup` on `/api/clients`.
- **Reports are per IPO.** An IPO must be chosen; there's no "All IPOs" option and no date or registrar filters in the UI.
- **Never automate around a captcha.** BSE/NSE, Cameo and Integrated Registry aren't supported because their pages show a captcha. Adapters must stop and report if a captcha appears (`hasCaptcha`).
- **Don't send real PANs to registrars** when testing without the user's go-ahead.
- Alerts are dashboard-only; there's no email or Telegram.
- UI: light, professional look. Icon buttons with tooltips (`iconBtn`, `data-tip`), custom confirm dialogs (`confirmDialog`) and toasts. Never use the native `confirm()` or `alert()`.

## Deployment and operations
- Production runs as the scheduled task **AllotmentChecker** (SYSTEM), logging to `logs\app.log`. IIS site `AllotmentChecker` with an SNI binding using the `*.investoyard.com` cert (WebHosting store). Needs URL Rewrite and ARR.
- **To ship a change:** commit and push, then the user double-clicks `update-app.bat` (it needs admin). This session can't restart the SYSTEM process. Restarting the IIS app pool does nothing for the app.
- `trustProxy` is `"127.0.0.1,::1"`. Only IIS on this machine can set X-Forwarded-For/Proto, which matters for the login lockout and audit IPs. The cookie becomes `Secure` automatically over HTTPS.
- Scheduler: every 10 minutes, 9:00–23:00 IST, for IPOs whose allotment date is today or yesterday.
- `.env` holds `DATABASE_URL`, `JWT_SECRET`, `PAN_ENC_KEY`, `PAN_HMAC_KEY` and `PORT=3100` (3000 is taken by an Investoyard tool). Never print or commit it. Losing `PAN_ENC_KEY` makes stored PANs unreadable.

## Gotchas
- **`prisma generate` fails with EPERM** while the service runs, because the query-engine DLL is locked. The JS and type files still get regenerated, which is enough for dev and tests. Delete the leftover `node_modules\.prisma\client\*.tmp*` files, and the restart through `update-app.bat` picks up the new client.
- **Don't edit UTF-8 files with Windows PowerShell `Get-Content`/`Set-Content` without encodings.** It reads them as ANSI and garbles ₹ — ‹ › ✓. Use the Edit tool, or `[IO.File]::ReadAllText(path, UTF8)` plus `WriteAllText` with `UTF8Encoding($false)`. `.bat` files need CRLF and ASCII.
- The Bash tool is Git Bash and the default shell is PowerShell 5.1: no `&&`, and use a here-string or a file for multi-line commit messages.
- Static files are served from disk, so UI changes are live on refresh. API and server changes need a restart.
- Registrar adapters marked **beta** (Skyline, Purva) parse HTML generically. An unrecognised page must become an ERROR result, never a guessed status.
- An e2e failure of the "job never finished" kind usually means a real runner race. Investigate it; don't raise timeouts.
