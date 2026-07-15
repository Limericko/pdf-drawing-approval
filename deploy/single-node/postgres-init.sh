#!/bin/sh
set -eu

read_secret() {
  value="$(cat "/run/pdf-approval-bootstrap/$1")"
  [ -n "$value" ] || { printf '%s\n' "EMPTY_POSTGRES_SECRET:$1" >&2; exit 1; }
  printf '%s' "$value"
}

export PLATFORM_MIGRATION_PASSWORD="$(read_secret migration-password.secret)"
export PLATFORM_WEB_PASSWORD="$(read_secret web-password.secret)"
export PLATFORM_WORKER_PASSWORD="$(read_secret worker-password.secret)"
export PLATFORM_BOOTSTRAP_PASSWORD="$(read_secret bootstrap-password.secret)"

psql --set ON_ERROR_STOP=on --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv database_name POSTGRES_DB
\getenv migration_password PLATFORM_MIGRATION_PASSWORD
\getenv web_password PLATFORM_WEB_PASSWORD
\getenv worker_password PLATFORM_WORKER_PASSWORD
\getenv bootstrap_password PLATFORM_BOOTSTRAP_PASSWORD

SELECT format('CREATE ROLE platform_migration LOGIN PASSWORD %L', :'migration_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_migration') \gexec
SELECT format('CREATE ROLE platform_web LOGIN PASSWORD %L', :'web_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_web') \gexec
SELECT format('CREATE ROLE platform_worker LOGIN PASSWORD %L', :'worker_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_worker') \gexec
SELECT format('CREATE ROLE platform_bootstrap LOGIN PASSWORD %L', :'bootstrap_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_bootstrap') \gexec

SELECT format('ALTER ROLE platform_migration WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'migration_password') \gexec
SELECT format('ALTER ROLE platform_web WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'web_password') \gexec
SELECT format('ALTER ROLE platform_worker WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'worker_password') \gexec
SELECT format('ALTER ROLE platform_bootstrap WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'bootstrap_password') \gexec

SELECT format('ALTER DATABASE %I OWNER TO platform_migration', :'database_name') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database_name') \gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO platform_migration, platform_web, platform_worker, platform_bootstrap',
  :'database_name'
) \gexec

CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION platform_migration;
ALTER SCHEMA platform OWNER TO platform_migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO platform_web, platform_worker, platform_bootstrap;
SQL
