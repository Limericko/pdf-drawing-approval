# 单机完整版

这是面向一台 Linux 云服务器的低维护部署包。一个 Compose 统一管理：

- PDF 审批 Web 与后台 Worker；
- PostgreSQL 17；
- MinIO 对象存储；
- 数据库迁移、首位管理员、备份、恢复与升级工具。

应用、数据库和对象存储仍是独立容器，避免把所有进程塞进一个难以升级的巨型容器；对管理员则表现为一个安装入口和一个运维入口。

## 服务器要求

- 64 位 Linux，建议至少 4 核、8 GB 内存、100 GB SSD；
- Docker Engine 与 Docker Compose v2；
- 一个已经解析到服务器公网 IP 的域名；
- 已安装的宝塔、Nginx、Traefik 或其他 HTTPS 反向代理；

SMTP 不再是安装前置条件。系统可以先启动使用，之后由管理员在“系统管理 → 邮件服务器”中填写外部 SMTP；邮件服务器本身不随包内置。

数据库和 MinIO API 不发布到宿主机。Web 默认只绑定 `127.0.0.1:18080`，不会直接暴露公网；端口可以在安装向导中修改。

## 安装

```sh
git clone https://github.com/Limericko/pdf-drawing-approval.git
cd pdf-drawing-approval
sudo ./deploy/single-node/install.sh
```

安装向导只询问域名和反向代理目标端口，随后自动：

1. 生成数据库、MinIO、TOTP、邀请、恢复和 CSRF 密钥；
2. 拉取并锁定应用镜像及固定版本依赖镜像；
3. 初始化 PostgreSQL 角色和 MinIO 私有存储桶；
4. 执行数据库 migration；
5. 幂等创建默认管理员；
6. 启动 Web 与 Worker。

安装、升级、恢复或手工迁移前，脚本都会把 PostgreSQL 中四个受限应用角色的密码与当前密钥目录重新同步。因此保留旧数据卷、迁移部署目录或轮换本地密钥后可以安全重跑安装，不需要删除数据库卷。

首次登录信息：

```text
用户名：admin
初始密码：admin123
```

首次登录只允许进入安全设置页，必须立即设置新密码；可同时修改用户名和管理员邮箱。完成后旧会话会自动失效，需要使用新信息重新登录。以后仍可在“系统管理 → 管理员账号”中修改用户名、邮箱和密码。

秘密保存在 `deploy/single-node/runtime/secrets/`，不会进入 Git。SMTP 密码由管理台加密保存，API 不会回传密码明文。不要手工删除或只备份数据库；身份、邮件设置与恢复流程需要数据库和这些密钥共同存在。

## 登录后配置邮件

进入“系统管理 → 邮件服务器”，填写服务器、端口、发件人邮箱、用户名、密码和连接加密方式。未配置 SMTP 时 Web 与 Worker 仍会正常运行，只是邀请邮件无法发送且邮件健康状态显示未配置；保存后 Worker 会自动读取新配置，无需重装或修改 Compose。

## 配置反向代理

安装完成时会显示实际目标，例如：

```text
http://127.0.0.1:18080
```

在宝塔中添加网站和 SSL 证书，然后把反向代理目标填写为该地址。不要在云安全组或系统防火墙中开放 `18080`。

Nginx 等价配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
    client_max_body_size 500m;
}
```

外部入口必须提供 HTTPS，并把 `X-Forwarded-Proto` 设置为 `https`；应用的安全 Cookie 和 CSRF 校验依赖该配置。修改端口时编辑 `deploy/single-node/.env` 中的 `PDF_APPROVAL_HTTP_PORT`，随后运行：

```sh
sudo ./deploy/single-node/ops.sh restart
```

## 日常维护

```sh
sudo ./deploy/single-node/ops.sh status
sudo ./deploy/single-node/ops.sh doctor
sudo ./deploy/single-node/ops.sh logs web
sudo ./deploy/single-node/ops.sh restart
sudo ./deploy/single-node/ops.sh backup
sudo ./deploy/single-node/ops.sh update
```

`update` 会先自动备份，再拉取镜像、执行 migration、滚动重建 Web/Worker，并在健康检查失败时恢复旧镜像引用。

恢复同一实例中的备份：

```sh
sudo ./deploy/single-node/ops.sh restore backups/20260715T120000Z
```

恢复会要求输入 `RESTORE` 二次确认。每个备份目录包含数据库、对象和 `configuration.tar.gz`。配置归档中含有密钥，必须通过加密链路复制到另一台主机或对象存储，不能只留在本机。

## 可用性边界

单机完整版能在容器或主机重启后自动恢复，但无法抵御整台云服务器、云盘或机房故障。要实现跨故障域持续可用，应切换到 `deploy/compose.production.yaml`，使用托管 PostgreSQL、托管 S3 和至少两台应用实例。

单机模式只对 Compose 内固定的 `http://minio:9000` 开放生产内部 S3 例外；其他 HTTP、IP、端口或主机名仍会被应用拒绝。
