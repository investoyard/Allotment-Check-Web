# Auto Check Allotment — Plan

Web app that checks IPO allotment status for many client PANs against registrar
(KFin, MUFG Intime/Link Intime, Bigshare, Skyline, Cameo, Purva, Maashitla, …)
and exchange (BSE/NSE) status pages, stores results, and reports on them.

## Decisions
| Topic | Decision |
|---|---|
| Users | Business use, 50–1000+ client PANs, multiple staff users |
| Platform | Web app hosted on this server |
| Stack | Node.js 24 + TypeScript, Fastify, Prisma, Playwright (adapters), vanilla HTML UI to start |
| Database | PostgreSQL — dedicated `allotment` database on the existing server (port 5433) |
| Captcha | Never auto-solved. Shown to an operator in a fast "captcha queue" screen |
| Output | Dashboard, Excel export, history report |

## Architecture
```
Web UI ──▶ Fastify API ──▶ PostgreSQL
              │
              ├─ Auth (roles: ADMIN, OPERATOR) + audit log
              ├─ Job queue + scheduler
              └─ Registrar adapters (one file each, common interface)
                   KFin | MUFG Intime | Bigshare | BSE | Skyline | Cameo | ...
```

Adapter interface:
```ts
interface RegistrarAdapter {
  id: string;
  listIpos(): Promise<IpoRef[]>;
  check(ipo: IpoRef, pan: string, ctx: CheckContext): Promise<CheckResult>;
  // ctx.solveCaptcha(image) → pauses and asks an operator in the UI
}
```
Fetch strategy per adapter: direct HTTP/JSON → headless browser (Playwright) →
human captcha. Polite rate limits (1–2 req/s per registrar), retry with backoff.

## Data model
- `User` — email, name, password hash (scrypt), role, active
- `Client` — code, name (a family / client group)
- `Pan` — client, PAN encrypted (AES-256-GCM), PAN HMAC (lookup/uniqueness), masked PAN, holder name, mobile, DP/Client ID
- `Ipo` — name, registrar, registrar IPO id, allotment & listing dates, prices *(Phase 2)*
- `CheckResult` — ipo, pan, status, applied qty, allotted qty, checked at, raw *(Phase 2)*
- `Job` — ipo, state, progress, errors *(Phase 2)*
- `AuditLog` — user, action, entity, details, time

Statuses: `ALLOTTED`, `NOT_ALLOTTED`, `NOT_APPLIED`, `PENDING`, `CAPTCHA_REQUIRED`, `ERROR`.

## Security & compliance
- PANs encrypted at rest; masked in UI (`ABCPX****K`) unless permitted; never in URLs/logs
- Role-based access, audit log of checks/exports/imports
- DPDP Act 2023: client consent, retention policy, delete/anonymise function

## Reports
- **Dashboard** — IPOs with progress; IPO × PAN grid, colour-coded
- **Excel export** — per IPO, per client, all
- **History report** — per PAN/client: IPOs applied, applied vs allotted, allotment ratio;
  filters by date, client, registrar, IPO; optional listing gain/loss

## Phases
| # | Deliverable | Status |
|---|---|---|
| 1 | Project setup, Postgres schema, login/roles, client & PAN import from Excel/CSV, encrypted storage, audit log | Done |
| 2 | First adapter (MUFG Intime), job queue, results storage, basic dashboard | Done; live PAN check not yet verified |
| 3 | KFin, Bigshare, BSE adapters + captcha queue screen | |
| 4 | Excel export + history report with filters | |
| 5 | Scheduler (auto-run on allotment day), retries, alerts | |
| 6 | Remaining registrars, IPO calendar, listing P&L | |

## Registrar notes
- **MUFG Intime** — `in.mpms.mufg.com/Initial_Offer/IPO.aspx`. Page methods `GetDetails` (IPO list),
  `generateToken` (one-time token, AES-128-CBC encoded with the key from the page's own JS) and
  `SearchOnPan`. Captcha is present on the page but disabled in its script (as of 2026-10-28).
  No captcha queue needed for MUFG yet.

## Risks
- Registrar sites change often → adapters isolated, easy to patch
- Captchas prevent fully unattended runs on some sites
- Bulk checking must stay polite and within each site's terms of use
