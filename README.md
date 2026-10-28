# Auto Check Allotment

IPO allotment checker for client PANs. See [PLAN.md](PLAN.md) for the roadmap.

## Setup (first time)

1. **Install dependencies**
   ```
   npm install
   ```
2. **Configure `.env`.** It already has generated keys and a database password.
   **Back up `PAN_ENC_KEY` and `PAN_HMAC_KEY`.** If you lose them, the stored PANs can't be read.
3. **Create the database** on the existing Postgres server (port 5433), as a Postgres superuser.
   The script reads the password from `.env` and is safe to re-run:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\setup-db.ps1 -SuperUser <superuser>
   ```
4. **Create tables**
   ```
   npm run db:deploy
   ```
5. **Create the first admin**
   ```
   npm run create-admin -- you@example.com "Your Name"
   ```
6. **Run:** double-click **`start-app.bat`**. It:
   - applies any database updates,
   - starts the app,
   - opens http://localhost:3100 in your browser.

   Keep its window open while you use the app: closing it stops the app and the automatic checks. Double-clicking it again while the app is running just opens the browser.
   From a terminal, `npm run dev` does the same, with auto-reload while you edit code.

## Importing PANs
Use **Import** in the UI with an `.xlsx` or `.csv` file. Headers are matched flexibly:

| Field | Required | Accepted headers |
|---|---|---|
| PAN | yes | PAN, PAN No, PAN Number |
| Name | yes | Name, Holder Name, Investor Name, Applicant Name |
| Client | no | Client, Client Name, Group, Family, Client Code |
| Mobile | no | Mobile, Mobile No, Phone |
| DP ID | no | DP ID, Demat, BOID, DP Client ID |

- **Preview** first. Nothing is saved until you click **Import**.
- Re-importing the same PAN updates that record instead of creating a duplicate.
- See `samples/pans-template.csv` for an example file.

## Checking allotment
1. On **IPOs**, click **Show live IPOs at all registrars**. Enter the allotment date if you know it, then click **Track**.
2. Open the IPO and click **Check unchecked**, or let the scheduler do it on allotment day. The check runs in the background, so you can close the page.
   - Each registrar gets about one PAN per second, so 1000 PANs take roughly 15–20 minutes.
   - Checks for different registrars run in parallel.
   - Temporary failures (site busy, timeouts) are retried 3 times automatically.
   - If the server restarts, the check carries on where it stopped.
3. **Re-check errors / not applied** retries only those PANs. Registrars sometimes publish data in batches on allotment day.

Supported registrars:

| Registrar | Speed | Notes |
|---|---|---|
| MUFG Intime (Link Intime) | ~1 PAN/s | |
| KFin Technologies | ~1 PAN/s | |
| Bigshare Services | ~1 PAN / 3 s | Their server rate-limits, so the tool waits whenever it is asked to |
| Maashitla Securities | ~1 PAN/s | |
| Skyline Financial Services | ~1 PAN / 1.5 s | **Beta:** the result page hasn't been seen with a real PAN yet. A page the tool can't read shows as an error, never as a guessed status |
| Purva Sharegistry | ~1 PAN / 1.5 s | **Beta**, same as Skyline |

**Not supported, because their status pages show a captcha:** BSE/NSE, Cameo and Integrated Registry. Check those manually. BSE/NSE only show the registrar's data anyway.
If a supported registrar ever adds a captcha, its adapter stops and reports an error instead of trying to get around it.

You can test an adapter from the command line without using the database:
```
npm run registrar -- ipos mufg        (or kfin, bigshare)
npm run registrar -- check mufg <ipoId> <PAN>
```

## Automatic checks on allotment day
On the IPO page, set the **Allotment date** and keep **Auto-check on allotment day** ticked. The server then does this by itself:
- **Every 10 minutes, 9:00–23:00 IST,** on allotment day and the day after, it checks any PANs not checked yet.
- **If the registrar hasn't published yet** (everything comes back "not applied"), it doesn't re-check every PAN. Every 30 minutes it **probes 10 random PANs**, and once a probe finds a real application it re-checks everyone.
- **Errors** are retried automatically, up to 3 times, 15 minutes apart.
- **The IPOs page** shows a **Today's allotments** panel with what it's doing. Admins can click **Run scheduler now**.

Settings in `.env` (optional): `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MIN`, `SCHEDULER_START_HOUR`, `SCHEDULER_END_HOUR`.
The server has to be running for this to work. See "Running as a service" below.

## Reports and Excel
- **IPO page → Download Excel:** a Summary sheet plus a Results sheet for every PAN, using the filters on screen.
- **Reports tab:** allotment history per client or per PAN.
  - Shows IPOs applied, allotted, allotment ratio, shares applied and allotted, and allotted value (shares × issue price, where the registrar gives a price).
  - Filters by date range, client, registrar or IPO.
  - **Download Excel** gives Overview, By client, By PAN and Detail sheets.
- **Only "Allotted" and "Not allotted" count as applied.** "Not applied" and errors are left out of the ratio.
- **PANs in exports are masked.** Admins can tick **Full PANs**, and every export is written to the audit log.
- **Listing gain:** enter the **Listing price** on the IPO page. If you also enter an **Issue price**, it's used; otherwise the price the registrar reported is.
  - Gain = (listing − issue) × shares allotted. It's shown on the IPO page, in reports and in both Excel files.
  - Allotments with no listing price yet are counted separately (marked \* in reports).

## Roles
- **ADMIN**: manage users, import and edit PANs, reveal full PANs (each reveal is logged), view the audit log.
- **OPERATOR**: view PANs (masked), track IPOs, and run or cancel allotment checks.

## Running as a service
`npm run dev` stops when you close the terminal. To keep it running, so auto-checks happen, start it at boot with Windows Task Scheduler:
- **Action:** `npm.cmd`, **arguments** `start`, **start in** `D:\Claude\AutoCheckAllotment`
- **Trigger:** "At startup"
- **Settings:** "Run whether user is logged on or not"

## Development
```
npm test
npm run typecheck
npm run test:e2e     # full flow against the real Postgres, in a throwaway schema, with a fake registrar
```
