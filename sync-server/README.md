# FineShell 主机同步服务

同步服务运行在你控制的服务器上。桌面应用用邮箱和账号密码登录，使用独立生成的恢复密钥在设备端加解密 SSH 数据。SQLite 保存账号、登录会话和加密后的同步数据。请同样保护并备份 SQLite 数据库。

## Windows 或本机开发

使用 Node.js 26。在项目根目录安装服务依赖并启动：

```powershell
npm ci --prefix sync-server --omit=dev --ignore-scripts
$env:FINESHELL_SYNC_DATABASE = "C:\data\fineshell-sync.sqlite"
$env:FINESHELL_SYNC_PORT = "8787"
node sync-server/server.mjs
```

数据库目录需提前创建。服务监听本机的 `127.0.0.1:8787`。本机开发时，在桌面应用的「设置 → 主机同步」填写 `http://127.0.0.1:8787`。跨设备使用时，通过 HTTPS 反向代理访问该端口。发布前设置 `VITE_FINESHELL_SYNC_URL` 可为桌面应用预填服务地址。

## Linux 部署

### Docker Compose

从 `sync-server` 目录执行。容器以普通用户运行，数据库保存在命名卷 `vault`，宿主机只监听回环地址。

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:8787/healthz
```

配置发信时在 `sync-server` 目录创建权限为 `0600` 的 `.env`，可参考 [配置示例](deploy/sync.env.example)。升级前备份命名卷中的数据库，更新源码后再次运行 `docker compose up -d --build`。保留现有命名卷。

### systemd

先安装 Node.js 26。以下步骤采用与 [服务单元](deploy/fineshell-sync.service) 一致的路径，Node.js 安装于 `/opt/fineshell-sync/node`。如果使用系统提供的 Node.js，则相应修改单元里的 `ExecStart`。从仓库根目录执行：

```bash
sudo install -d -m 0755 /opt/fineshell-sync
sudo install -d -m 0700 /etc/fineshell-sync
sudo install -m 0644 sync-server/server.mjs sync-server/onboarding.mjs sync-server/package.json sync-server/package-lock.json /opt/fineshell-sync/
sudo install -m 0644 sync-server/deploy/backup-snapshot.mjs /opt/fineshell-sync/
sudo env PATH=/opt/fineshell-sync/node/bin:/usr/bin:/bin /opt/fineshell-sync/node/bin/npm ci --prefix /opt/fineshell-sync --omit=dev --ignore-scripts
sudo install -m 0644 sync-server/deploy/fineshell-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fineshell-sync
curl --fail http://127.0.0.1:8787/healthz
```

systemd 管理 `/var/lib/fineshell-sync`，重启和升级保留数据。发信配置放在 `/etc/fineshell-sync/sync.env`，仅允许 root 读取。升级前创建快照，更新程序文件和依赖后执行 `sudo systemctl restart fineshell-sync`，通过 `journalctl -u fineshell-sync` 和 `/healthz` 核对。

两种方式都可以在本机前置 Nginx 或其他反向代理终止 HTTPS。代理到 `127.0.0.1:8787`，转发 `Authorization`，请求体上限至少为 8 MiB。跨设备客户端填写 HTTPS 域名。

登录、注册和验证码接口同时使用来源限流。systemd 直连回环反向代理部署可让 Nginx 覆盖 `X-Real-IP`（`proxy_set_header X-Real-IP $remote_addr;`），然后在服务端配置增加 `FINESHELL_SYNC_TRUST_LOOPBACK_PROXY=1`。只有来自回环的连接才能使用这个头。服务日志记录异常注册及限流的汇总数量，包含 `FineShell authentication activity` 的条目可接入告警。

## 邀请注册与邮箱验证

默认模式 `open` 兼容原有自助注册。启用邀请制时，将服务端配置中的 `FINESHELL_SYNC_REGISTRATION` 设为 `invite`。现有账号可以继续登录。新账号需要管理员分发的邀请码和验证码。邀请码绑定邮箱、七天有效，注册成功后即失效。邮箱验证码有效期为 15 分钟。

可使用自建 SMTP 或 Resend 发信。SMTP 465 使用隐式 TLS，SMTP 587 使用强制 STARTTLS，两种方式都验证证书。

```dotenv
FINESHELL_SYNC_REGISTRATION=invite
FINESHELL_SYNC_MAIL_PROVIDER=smtp
FINESHELL_SYNC_MAIL_FROM=sync@example.com
FINESHELL_SYNC_SMTP_HOST=mail.example.com
FINESHELL_SYNC_SMTP_PORT=465
FINESHELL_SYNC_SMTP_USER=sync@example.com
FINESHELL_SYNC_SMTP_PASSWORD=<SMTP 密码>
```

使用 Resend 时改设 `FINESHELL_SYNC_MAIL_PROVIDER=resend`，提供 `FINESHELL_SYNC_MAIL_FROM` 和 `FINESHELL_SYNC_RESEND_API_KEY`。修改配置后重启服务。用下面与你部署方式对应的命令创建邀请码，将输出私下分发给指定邮箱的用户。

```bash
sudo env FINESHELL_SYNC_DATABASE=/var/lib/fineshell-sync/vault.sqlite /opt/fineshell-sync/node/bin/node /opt/fineshell-sync/onboarding.mjs invite user@example.com
docker compose exec sync node onboarding.mjs invite user@example.com
```

## 跨设备使用

1. 在第一台设备的「主机同步」中创建账号，把生成的恢复密钥保存在密码管理器。
2. 在另一台设备中输入同一个服务地址、账号密码和恢复密钥。成功后凭据会写入设备的系统凭据库，私钥文件导入本机。首次连接时仍需按提示核对服务器指纹。SSH Agent 中的密钥要在对应设备配置。
3. 主窗口运行期间每 15 秒检查一次，可在设置里点「立即同步」。不同主机的修改会合并。同一项在两台设备同时修改时，设置中可比较并逐项选择版本。本机找不到某个私钥文件时，其他主机仍会同步，设置会显示受影响条目并提供重新关联入口。
4. 一个 FineShell 本地配置绑定一个同步账号。退出登录会停止自动同步，已同步的连接仍保留在本机。同步设置可以查看账号的登录设备和最后同步时间，重命名当前设备，并撤销其他设备的登录。

同步包括已保存的主机、分组、关联代理与 SSH 密钥，以及已经保存的对应密码或口令。连接历史、服务器指纹信任、应用设置和终端记录保留在各设备。恢复密钥丢失后，账号密码无法解密远端主机数据。

## 异机备份与恢复

Linux 可以使用 SQLite 在线备份与完整性检查脚本：

```bash
sudo env FINESHELL_SYNC_DATABASE=/var/lib/fineshell-sync/vault.sqlite /opt/fineshell-sync/node/bin/node /opt/fineshell-sync/backup-snapshot.mjs /var/backups/fineshell-sync
docker compose exec sync node backup-snapshot.mjs /data/backups
```

Linux 快照仍包含账号与会话数据。将快照转存到受访问控制的加密异机存储。Compose 可用 `docker compose cp sync:/data/backups/<快照文件> .` 取回已完成的快照。

在另一台 Windows 电脑上运行 PowerShell 7。确认任务账号可以使用已固定的服务器主机指纹通过 SSH 登录。脚本使用 SQLite 在线备份 API 生成一致快照，给快照加上 Windows DPAPI 当前用户保护，再保存到本地。使用任务计划程序时让同一个 Windows 用户执行脚本。电脑关机或该账号未登录期间，备份可能延迟。

```powershell
pwsh -File ./sync-server/deploy/backup-to-windows.ps1 `
  -SshTarget 'your-sync-host' -KnownHosts 'C:\path\known_hosts' `
  -Destination 'C:\path\FineShellSyncBackups' -RestoreDrill
```

`-RestoreDrill` 使用 Node.js 26 解密新保存的快照，在内存中执行 SQLite 完整性检查并验证账号和会话表可读。可用 `-NodePath` 指定 Node.js。默认保留最近 30 天，只有备份成功后才清理旧快照。快照需要原 Windows 用户的 DPAPI 密钥，应保留该 Windows 用户配置及恢复手段。

服务故障时，先在隔离环境中解密并验证选定的快照。切换生产数据库前停止 `fineshell-sync`，完整归档原 SQLite 文件及其 WAL、SHM 文件，确保旧的 WAL 不会与恢复文件混用。在恢复文件上执行 `DELETE FROM sessions;`，在含邀请功能的数据库上同时清空 `email_verifications` 和 `invites` 表，避免已撤销会话或已使用邀请恢复有效。按原权限放置数据库后再启动服务并核对 `/healthz`。恢复到早于某台设备最后验证版本的快照后，该设备会检测到回退。重新登录后，在同步设置中确认用最近验证过的设备恢复云端。客户端会重新加密该快照并发布更高的版本。备份之后新建且未被快照保留的账号需要单独找回。

## 服务测试

```powershell
npm ci --prefix sync-server --ignore-scripts
node --test sync-server/server.integration.mjs
```
