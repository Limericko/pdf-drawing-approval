#!/bin/sh
set -eu
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$ROOT/.env"
COMPOSE_FILE="$ROOT/compose.yaml"
SECRETS_ROOT="$ROOT/runtime/secrets"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

read_env() {
  key="$1"
  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1)"
  printf '%s' "$value"
}

write_env() {
  key="$1"
  value="$2"
  case "$value" in
    *=*) fail "配置 $key 含有不支持的字符" ;;
  esac
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

prompt_value() {
  key="$1"
  label="$2"
  fallback="$3"
  current="$(read_env "$key")"
  case "$current" in
    ""|*example.com*) current="$fallback" ;;
  esac
  printf '%s [%s]: ' "$label" "$current" >&2
  IFS= read -r answer
  [ -n "$answer" ] || answer="$current"
  [ -n "$answer" ] || fail "$label 不能为空"
  write_env "$key" "$answer"
}

random_urlsafe() {
  openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'
}

random_base64() {
  openssl rand -base64 48 | tr -d '\n'
}

write_secret() {
  directory="$1"
  name="$2"
  value="$3"
  owner="$4"
  install -d -m 0750 -o "$owner" -g "$owner" "$SECRETS_ROOT/$directory"
  printf '%s' "$value" > "$SECRETS_ROOT/$directory/$name"
  chown "$owner:$owner" "$SECRETS_ROOT/$directory/$name"
  chmod 0400 "$SECRETS_ROOT/$directory/$name"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

[ "$(id -u)" -eq 0 ] || fail "请使用 sudo ./deploy/single-node/install.sh 运行"
require_command docker
require_command openssl
docker compose version >/dev/null 2>&1 || fail "需要 Docker Compose v2"
docker info >/dev/null 2>&1 || fail "Docker 服务未运行"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

printf '%s\n' "PDF 审批单机版安装向导"
prompt_value PDF_APPROVAL_DOMAIN "公网域名（已解析到本机）" ""
prompt_value PDF_APPROVAL_HTTP_PORT "反向代理目标端口" "18080"

domain="$(read_env PDF_APPROVAL_DOMAIN)"
case "$domain" in
  *://*|*/*|*:*|""|.*|*.) fail "域名只能填写主机名，例如 approval.example.com" ;;
esac
printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$' ||
  fail "域名只能填写主机名，例如 approval.example.com"

bind_address="$(read_env PDF_APPROVAL_BIND_ADDRESS)"
if [ -z "$bind_address" ]; then
  bind_address="127.0.0.1"
  write_env PDF_APPROVAL_BIND_ADDRESS "$bind_address"
fi
[ "$bind_address" = "127.0.0.1" ] || fail "单机版默认只允许绑定 127.0.0.1，请通过同机反向代理访问"
http_port="$(read_env PDF_APPROVAL_HTTP_PORT)"
case "$http_port" in *[!0-9]*|"") fail "反向代理目标端口必须是数字" ;; esac
[ "$http_port" -ge 1024 ] && [ "$http_port" -le 65535 ] || fail "反向代理目标端口必须在 1024–65535 之间"

install -d -m 0750 "$ROOT/runtime" "$ROOT/backups"

if [ ! -f "$SECRETS_ROOT/postgres/postgres-password.secret" ]; then
  printf '%s\n' "正在生成数据库、存储和会话密钥……"
  postgres_password="$(random_urlsafe 36)"
  migration_password="$(random_urlsafe 36)"
  web_password="$(random_urlsafe 36)"
  worker_password="$(random_urlsafe 36)"
  bootstrap_password="$(random_urlsafe 36)"
  s3_access_key="$(random_urlsafe 18)"
  s3_secret_key="$(random_urlsafe 42)"
  totp_keyring="{\"currentVersion\":\"v1\",\"keys\":{\"v1\":\"$(random_base64)\"}}"
  invitation_keyring="{\"currentVersion\":\"v1\",\"keys\":{\"v1\":\"$(random_base64)\"}}"
  recovery_keyring="{\"currentVersion\":\"v1\",\"keys\":{\"v1\":\"$(random_base64)\"}}"
  csrf_keyring="{\"currentVersion\":\"v1\",\"keys\":{\"v1\":\"$(random_base64)\"}}"

  write_secret postgres postgres-password.secret "$postgres_password" 70
  write_secret postgres migration-password.secret "$migration_password" 70
  write_secret postgres web-password.secret "$web_password" 70
  write_secret postgres worker-password.secret "$worker_password" 70
  write_secret postgres bootstrap-password.secret "$bootstrap_password" 70
  write_secret minio access-key.secret "$s3_access_key" 1000
  write_secret minio secret-key.secret "$s3_secret_key" 1000

  write_secret web database-url.secret "postgresql://platform_web:$web_password@postgres:5432/pdf_approval" 10001
  write_secret worker database-url.secret "postgresql://platform_worker:$worker_password@postgres:5432/pdf_approval" 10001
  write_secret migration database-url.secret "postgresql://platform_migration:$migration_password@postgres:5432/pdf_approval" 10001
  write_secret bootstrap database-url.secret "postgresql://platform_bootstrap:$bootstrap_password@postgres:5432/pdf_approval" 10001

  write_secret web s3-access-key.secret "$s3_access_key" 10001
  write_secret web s3-secret-key.secret "$s3_secret_key" 10001
  write_secret worker s3-access-key.secret "$s3_access_key" 10001
  write_secret worker s3-secret-key.secret "$s3_secret_key" 10001
  write_secret web totp-keyring.secret "$totp_keyring" 10001
  write_secret bootstrap totp-keyring.secret "$totp_keyring" 10001
  write_secret web invitation-hmac-keyring.secret "$invitation_keyring" 10001
  write_secret worker invitation-hmac-keyring.secret "$invitation_keyring" 10001
  write_secret web recovery-hmac-keyring.secret "$recovery_keyring" 10001
  write_secret bootstrap recovery-hmac-keyring.secret "$recovery_keyring" 10001
  write_secret web csrf-hmac-keyring.secret "$csrf_keyring" 10001
  write_secret worker webdav-credentials.json '{}' 10001
fi

for required_secret in \
  postgres/postgres-password.secret \
  postgres/migration-password.secret \
  postgres/web-password.secret \
  postgres/worker-password.secret \
  postgres/bootstrap-password.secret \
  minio/access-key.secret \
  minio/secret-key.secret \
  web/database-url.secret \
  worker/database-url.secret \
  migration/database-url.secret \
  bootstrap/database-url.secret
do
  [ -s "$SECRETS_ROOT/$required_secret" ] || fail "密钥目录不完整：$required_secret"
done

printf '%s\n' "正在检查配置并拉取固定版本镜像……"
compose config --quiet
compose pull

configured_image="$(read_env PDF_APPROVAL_IMAGE)"
case "$configured_image" in
  *@sha256:*) ;;
  *)
    resolved_image="$(docker image inspect --format '{{index .RepoDigests 0}}' "$configured_image" 2>/dev/null || true)"
    if [ -n "$resolved_image" ]; then
      write_env PDF_APPROVAL_IMAGE "$resolved_image"
      printf '%s\n' "应用镜像已锁定为 $resolved_image"
    fi
    ;;
esac

printf '%s\n' "正在初始化 PostgreSQL、MinIO 和数据库结构……"
compose up -d postgres minio
compose exec -T postgres /docker-entrypoint-initdb.d/001-pdf-approval-roles.sh
compose --profile tools run --rm migration
compose --profile tools run --rm single-node-bootstrap
compose up -d --remove-orphans web worker

compose ps
printf '%s\n' "安装完成：https://$domain"
printf '%s\n' "请把宝塔/Nginx 反向代理目标设置为：http://127.0.0.1:$http_port"
printf '%s\n' "初始管理员：admin / admin123（首次登录必须立即修改密码）"
printf '%s\n' "维护入口：sudo ./deploy/single-node/ops.sh status"
