# FineShell 主机同步服务

同步服务运行在你控制的服务器上。桌面应用用邮箱和账号密码登录，使用独立生成的恢复密钥在设备端加解密 SSH 数据。SQLite 保存账号、登录会话和加密后的同步数据。请同样保护并备份 SQLite 数据库。

## 启动服务

使用 Node.js 26，服务无需安装 npm 依赖。在项目根目录运行：

```powershell
$env:FINESHELL_SYNC_DATABASE = "C:\data\fineshell-sync.sqlite"
$env:FINESHELL_SYNC_PORT = "8787"
node sync-server/server.mjs
```

数据库目录需提前创建。服务监听本机的 `127.0.0.1:8787`。本机开发时，在桌面应用的「设置 → 主机同步」填写 `http://127.0.0.1:8787`。跨设备使用时，通过 HTTPS 反向代理访问该端口。发布前设置 `VITE_FINESHELL_SYNC_URL` 可为桌面应用预填服务地址。

Linux/systemd 部署可使用 [fineshell-sync.service](deploy/fineshell-sync.service)。服务文件约定 Node 位于 `/opt/fineshell-sync/node/bin/node`，入口为 `/opt/fineshell-sync/server.mjs`，数据库保存在 `/var/lib/fineshell-sync`。反向代理至少允许 8 MiB 请求体并转发 Authorization，健康检查使用 `GET /healthz`。更新程序文件时保留数据库目录。

当前部署提供自助注册。邮箱用于标识账号，尚未配置邮箱验证或账号找回。如果服务只供个人或团队使用，请把 HTTPS 入口限制在内网或 VPN 内。

## 跨设备使用

1. 在第一台设备的「主机同步」中创建账号，把生成的恢复密钥保存在密码管理器。
2. 在另一台设备中输入同一个服务地址、账号密码和恢复密钥。成功后凭据会写入设备的系统凭据库，私钥文件导入本机。首次连接时仍需按提示核对服务器指纹。SSH Agent 中的密钥要在对应设备配置。
3. 主窗口运行期间每 15 秒检查一次，可在设置里点「立即同步」。不同主机的修改会合并。同一项在两台设备同时修改时，设置中可以选择保留哪一方。
4. 一个 FineShell 本地配置绑定一个同步账号。退出登录会停止自动同步，已同步的连接仍保留在本机。

同步包括已保存的主机、分组、关联代理与 SSH 密钥，以及已经保存的对应密码或口令。连接历史、服务器指纹信任、应用设置和终端记录保留在各设备。恢复密钥丢失后，账号密码无法解密远端主机数据。

## 服务测试

```powershell
node --test sync-server/server.integration.mjs
```
