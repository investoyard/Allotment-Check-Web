# Auto Check Allotment

IPO allotment checker for client PANs. See [PLAN.md](PLAN.md) for the roadmap.

## Setup (first time)

1. **Install dependencies**
   ```
   npm install
   ```
2. **Create the database** on the existing Postgres server (port 5433). Edit the password in
   `scripts/create-db.sql`, then run it as a Postgres superuser:
   ```
   D:\Investoyard\.tools\pgsql\bin\psql.exe -p 5433 -U <superuser> -d postgres -f scripts/create-db.sql
   ```
3. **Configure `.env`.** It already has generated keys. Set `DATABASE_URL` to the password you chose.
   **Back up `PAN_ENC_KEY` and `PAN_HMAC_KEY`.** If you lose them, the stored PANs can't be read.
4. **Create tables**
   ```
   npm run db:deploy
   ```
5. **Create the first admin**
   ```
   npm run create-admin -- you@example.com "Your Name"
   ```
6. **Run**
   ```
   npm run dev
   ```
   Then open http://127.0.0.1:3000.

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
1. On **IPOs**, pick a registrar and click **Show IPOs from registrar**. Then click **Track** next to the IPO.
2. Open the IPO and click **Check unchecked**. The check runs in the background, so you can close the page.
   - Each registrar gets about one PAN per second, so 1000 PANs take roughly 15–20 minutes.
   - Checks for different registrars run in parallel.
   - Temporary failures (site busy, timeouts) are retried 3 times automatically.
   - If the server restarts, the check carries on where it stopped.
3. **Re-check errors / not applied** retries only those PANs. Registrars sometimes publish data in batches on allotment day.

Supported registrars: **MUFG Intime** (Link Intime).

You can test an adapter from the command line without using the database:
```
npm run registrar -- ipos mufg
npm run registrar -- check mufg <ipoId> <PAN>
```

## Roles
- **ADMIN**: manage users, import and edit PANs, reveal full PANs (each reveal is logged), view the audit log.
- **OPERATOR**: view PANs (masked), track IPOs, and run or cancel allotment checks.

## Development
```
npm test
npm run typecheck
```
