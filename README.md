# AionUi-Local-2.2.2

AionUi v2.2.2 + AionCore v0.2.2 的**本地构建版**仓库：桌面版免登录直用，网页版可单用户免登录、也可开启多用户（按账号隔离数据）。仅供个人本地学习与研究使用，与官方 AionUi / AionPro 无隶属关系。

## 结构

```
AionUi-Local-2.2.2/
├─ AionUi/          # 前端 v2.2.2（多用户开关补丁；AuthContext 保持上游原样）
├─ AionCore/        # 后端 aioncore v0.2.2（find_by_model 按用户回退补丁）
├─ patches/         # 上述补丁的存档（升级时重放；CI 直接构建源码树，不读此目录）
└─ .github/workflows/
   ├─ build-win-installer.yml   # 云端构建 Windows 安装包（桌面，免登录）
   └─ build-linux-web.yml       # 云端构建 Linux 网页版 tarball
```

## 补丁清单

### 前端（AionUi）

| 文件 | 改动 |
|------|------|
| `packages/web-host/src/backend-launcher.ts` | aioncore 启动参数 `--local` 由硬编码改为环境变量开关：`local: process.env.AIONUI_MULTIUSER !== '1'`。默认关 = 上游单用户行为；`AIONUI_MULTIUSER=1` 时后端走 `identity_mode=webui`（JWT 登录、按用户隔离数据） |

`AuthContext.tsx` 的 `isDesktopRuntime` **保持上游原样**（`Boolean(window.electronAPI)`）：桌面运行时恒 true（永不跳 `/login`），浏览器运行时为 false（走登录页）。旧版硬编码 `= true` 的免登录补丁已撤销——它会让网页版永远进不了登录页，与多用户互斥；如需"网页免登录"部署再从 `patches/aionui-v2.2.2-auth-bypass.patch` 重放。

### 后端（AionCore）

| 文件 | 改动 |
|------|------|
| `crates/aionui-db/src/repository/provider.rs` | trait 增加 `find_by_model` 默认方法（返回 `None`） |
| `crates/aionui-db/src/repository/sqlite_provider.rs` | 实现 `find_by_model`：匹配**当前用户自己的** `enabled=1` 且 `models` 含目标模型名的 provider 行（`WHERE enabled = 1 AND user_id = ?`） |
| `crates/aionui-ai-agent/src/factory/aionrs.rs` | `find_by_id` 失败时回退 `find_by_model`，解决 aionrs 内置团队的 `Provider 'aionrs' not found` |

原因：aionrs 内置团队 agent 的 provider 行（`id='aionrs'`）只在登录后由服务器下发；本地/离线模式不存在该行，硬查会报错。回退按 user_id 严格限定在请求者名下——多用户模式下绝不解析到别人的 provider（API Key 不泄漏）。

## 三种运行形态

| 形态 | 登录页 | 数据 | 用法 |
|------|--------|------|------|
| 桌面 exe | 无，直进主界面 | 单用户 `system_default_user` | 装 `AionUi-local-win-x64` 即用 |
| 网页·免登录 | 有（上游原生密码门），登录后共享同一份数据 | 单用户 | 部署 tarball，不设 `AIONUI_MULTIUSER` |
| 网页·多用户 | 有，每个账号各自数据/配置/API Key | 按用户隔离 | 部署 tarball + 设 `AIONUI_MULTIUSER=1` |

## 网页版多用户操作手册

```bash
# 1. pm2 注入开关并持久化
AIONUI_MULTIUSER=1 pm2 restart aionui-web --update-env && pm2 save

# 2. admin 密码（首启 needs_setup 时前端启动日志会自动生成并打印；也可手动设）
echo "$PW" | /opt/aionui-web/aionui-web/bundled-aioncore/linux-x64/aioncore \
  --data-dir /opt/aionui-web/data user set-password --password-stdin

# 3. 建/吊销账号（CLI 直接开数据目录的 SQLite）
echo "$PW" | .../aioncore --data-dir /opt/aionui-web/data user create --username guest --password-stdin
.../aioncore --data-dir /opt/aionui-web/data user list
.../aioncore --data-dir /opt/aionui-web/data user disable --username guest   # 封号+踢掉全部在线会话

# 4. 回滚到单用户
AIONUI_MULTIUSER=0 pm2 restart aionui-web --update-env && pm2 save
```

要点：

- **数据连续**：`admin` 登录身份就是 `system_default_user`，现有全部对话、provider 配置原样可见。
- **隔离边界**：对话/消息/provider（API Key）/MCP/文件工作区全部按 user_id 隔离；但所有用户仍跑在同一个 aioncore 进程、同一 OS 用户下——应用层隔离，不是虚拟机级。
- 网关（Authelia）可保留作外围门；应用层限流、会话吊销（`session_generation`）、QR 登录（机主免密登自己号）均已内置。

## 云端构建

推送到 main（路径过滤 `AionCore/**`、`AionUi/**`）或手动触发 workflow：

1. `cargo build --release` 编译 aioncore（win: MSVC 安装包 / linux: tarball）
2. `aioncore prepare-managed-resources` 生成自包含 bundle
3. `bun install` + `AIONUI_BACKEND_LOCAL_BUNDLE_DIR=<bundle>` 注入本地 bundle（不下载官方 exe）
4. 产物：artifact `AionUi-local-win-x64`（NSIS 安装包）/ `aionui-web-linux-x64`（tarball + sha256，保留 30 天）

## 与登录挂钩的行为

- ✅ 桌面：启动直进主界面、Local 身份（`system_default_user`）、单人对话、团队多智能体（find_by_model 回退）、历史聊天、Sentry 遥测（匿名设备 UUID）
- ✅ 网页·多用户：登录页 + 各账号独立数据；guest 用自己的 API Key，aionrs 团队回退只命中自己名下的 provider
- ⚠️ 上游 WebUI 的管理员密码 / QR 登录：桌面版不涉及；网页版按形态生效（见上表）
- ❌ 不在范围：多端同步、云端空间等远程账号服务
- 与应用登录无关、保留不动：MCP OAuth、模型 provider OAuth（Claude/Google 登录）、微信渠道登录、Sentry

## 免责声明

本项目修改了原软件的认证与 provider 解析逻辑，仅用于个人本地自由使用。使用者需自行承担相关风险，并遵守所在地法律法规。
