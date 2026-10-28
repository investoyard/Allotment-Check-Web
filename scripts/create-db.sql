-- Run once as a Postgres superuser on the existing server (port 5433):
--   D:\Investoyard\.tools\pgsql\bin\psql.exe -p 5433 -U <superuser> -d postgres -f scripts/create-db.sql
-- Replace CHANGE_ME with a strong password and put the same one in .env.

CREATE ROLE allotment WITH LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE allotment OWNER allotment;
-- Lets `prisma migrate dev` create its temporary shadow database.
ALTER ROLE allotment CREATEDB;
