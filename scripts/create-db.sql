-- Creates the app's own role and database. Run through scripts/setup-db.ps1, which reads the
-- password from .env and passes it in as :app_password (so it never sits in this file).
-- Safe to re-run: it only creates what is missing and resets the password.

SELECT format('CREATE ROLE allotment WITH LOGIN CREATEDB PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'allotment') \gexec

ALTER ROLE allotment WITH LOGIN CREATEDB PASSWORD :'app_password';

SELECT 'CREATE DATABASE allotment OWNER allotment'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'allotment') \gexec

SELECT 'allotment role and database are ready' AS result;
