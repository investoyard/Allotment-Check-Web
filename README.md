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
   npm run db:migrate -- --name init
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

## Roles
- **ADMIN**: manage users, import and edit PANs, reveal full PANs (each reveal is logged), view the audit log.
- **OPERATOR**: view PANs (masked) and, from Phase 2 on, run allotment checks.

## Development
```
npm test
npm run typecheck
```
