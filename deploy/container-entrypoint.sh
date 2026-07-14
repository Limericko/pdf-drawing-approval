#!/bin/sh
set -eu
umask 077

target="${1:-web}"
shift || true

case "$target" in
  web)
    export PDF_APPROVAL_RUNTIME_MODE=platform
    exec node --import tsx src/server/index.ts "$@"
    ;;
  worker)
    exec node --import tsx src/server/platform/jobs/workerMain.ts "$@"
    ;;
  migration)
    exec node --import tsx src/server/platform/database/migrateCli.ts "$@"
    ;;
  legacy-migration)
    exec node --import tsx src/server/platform/migration/legacyMigrationCli.ts "$@"
    ;;
  bootstrap-admin)
    exec node --import tsx src/server/commands/bootstrapAdmin.ts "$@"
    ;;
  *)
    printf '%s\n' 'INVALID_CONTAINER_PROCESS_TARGET' >&2
    exit 64
    ;;
esac
