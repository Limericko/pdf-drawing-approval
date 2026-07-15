#!/bin/sh
set -eu
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/compose.yaml"
BACKUP_ROOT="$ROOT/backups"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "尚未安装，请先运行 sudo ./deploy/single-node/install.sh"
command -v docker >/dev/null 2>&1 || fail "缺少 Docker"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

write_env() {
  key="$1"
  value="$2"
  temporary="$ENV_FILE.tmp"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  mv "$temporary" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

backup() {
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$BACKUP_ROOT/$timestamp"
  mkdir -p "$target/objects"
  chmod 700 "$target"
  printf '%s\n' "正在备份 PostgreSQL……"
  compose exec -T postgres pg_dump -U postgres -d pdf_approval -Fc > "$target/database.dump"
  printf '%s\n' "正在备份 MinIO 对象……"
  compose run --rm --no-deps -T -v "$target/objects:/backup" --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$(cat /run/pdf-approval-minio/access-key.secret)" "$(cat /run/pdf-approval-minio/secret-key.secret)"
    mc mirror --overwrite local/pdf-approval /backup
  '
  tar -C "$ROOT" -czf "$target/configuration.tar.gz" .env runtime/secrets
  chmod 600 "$target/database.dump" "$target/configuration.tar.gz"
  printf '%s\n' "备份完成：$target"
  printf '%s\n' "该目录包含密钥，请加密复制到另一台主机或对象存储。"
}

restore() {
  target="${1:-}"
  [ -n "$target" ] || fail "用法：ops.sh restore backups/时间戳"
  case "$target" in /*) ;; *) target="$ROOT/$target" ;; esac
  [ -f "$target/database.dump" ] || fail "缺少 database.dump"
  [ -d "$target/objects" ] || fail "缺少 objects 目录"
  printf '%s' "恢复会覆盖当前数据，输入 RESTORE 继续: " >&2
  IFS= read -r confirmation
  [ "$confirmation" = "RESTORE" ] || fail "已取消恢复"
  compose stop web worker
  compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='pdf_approval' AND pid <> pg_backend_pid();"
  compose exec -T postgres dropdb -U postgres --if-exists pdf_approval
  compose exec -T postgres createdb -U postgres -O platform_migration pdf_approval
  compose exec -T postgres psql -U postgres -d pdf_approval -v ON_ERROR_STOP=1 -c \
    "REVOKE CONNECT ON DATABASE pdf_approval FROM PUBLIC; GRANT CONNECT ON DATABASE pdf_approval TO platform_migration, platform_web, platform_worker, platform_bootstrap;"
  compose exec -T postgres pg_restore -U postgres --role=platform_migration --no-owner --exit-on-error -d pdf_approval < "$target/database.dump"
  compose run --rm --no-deps -T -v "$target/objects:/backup:ro" --entrypoint /bin/sh minio-init -ec '
    mc alias set local http://minio:9000 "$(cat /run/pdf-approval-minio/access-key.secret)" "$(cat /run/pdf-approval-minio/secret-key.secret)"
    mc mirror --overwrite --remove /backup local/pdf-approval
  '
  compose --profile tools run --rm migration
  compose up -d --remove-orphans web worker
  printf '%s\n' "恢复完成"
}

update() {
  new_image="${1:-ghcr.io/limericko/pdf-drawing-approval:0.9.2-refactor}"
  old_image="$(read_env PDF_APPROVAL_IMAGE)"
  backup
  write_env PDF_APPROVAL_IMAGE "$new_image"
  if ! compose pull web || ! compose --profile tools run --rm migration || ! compose up -d --remove-orphans web worker; then
    printf '%s\n' "升级失败，正在恢复旧镜像……" >&2
    write_env PDF_APPROVAL_IMAGE "$old_image"
    compose up -d --remove-orphans web worker
    exit 1
  fi
  resolved_image="$(docker image inspect --format '{{index .RepoDigests 0}}' "$new_image" 2>/dev/null || true)"
  [ -z "$resolved_image" ] || write_env PDF_APPROVAL_IMAGE "$resolved_image"
  attempts=0
  until compose exec -T web node deploy/healthcheck.mjs >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then break; fi
    sleep 3
  done
  if [ "$attempts" -ge 30 ]; then
    printf '%s\n' "健康检查失败，正在恢复旧镜像……" >&2
    write_env PDF_APPROVAL_IMAGE "$old_image"
    compose up -d --remove-orphans web worker
    exit 1
  fi
  printf '%s\n' "升级完成：$(read_env PDF_APPROVAL_IMAGE)"
}

command_name="${1:-help}"
shift || true
case "$command_name" in
  status) compose ps ;;
  doctor) compose config --quiet; compose ps; compose exec -T web node deploy/healthcheck.mjs ;;
  logs) compose logs --tail=200 -f "${1:-web}" ;;
  start) compose up -d --remove-orphans web worker ;;
  stop) compose stop ;;
  restart) compose up -d --remove-orphans --force-recreate web worker ;;
  bootstrap) compose --profile tools run --rm single-node-bootstrap ;;
  migrate) compose --profile tools run --rm migration ;;
  backup) backup ;;
  restore) restore "${1:-}" ;;
  update) update "${1:-}" ;;
  help|*)
    printf '%s\n' "用法：ops.sh status|doctor|logs [服务]|start|stop|restart|bootstrap|migrate|backup|restore <目录>|update [镜像]"
    ;;
esac
