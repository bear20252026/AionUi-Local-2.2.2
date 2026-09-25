# AionUi-Local-2.2.2

AionUi v2.2.2 + AionCore v0.2.2 的**本地免登录版**构建仓库。仅供个人本地学习与研究使用，与官方 AionUi / AionPro 无隶属关系。

## 结构

```
AionUi-Local-2.2.2/
├─ AionUi/          # 前端 v2.2.2（免登录补丁）
├─ AionCore/        # 后端 aioncore v0.2.2（find_by_model 全局回退补丁）
└─ .github/workflows/build-win-installer.yml   # 云端一键构建 Windows 安装包
```

## 补丁清单

### 前端（AionUi）

| 文件 | 改动 |
|------|------|
| `packages/desktop/src/renderer/hooks/context/AuthContext.tsx` | `isDesktopRuntime = true` — 任何运行时都视为本地桌面会话，永不跳转 `/login` |

桌面运行时上游本来就恒 authenticated；此补丁同时覆盖 WebUI 浏览器模式。后端启动参数 `--local`（`web-host/src/backend-launcher.ts` 一律 `local: true`）上游已内置，无需改动。

### 后端（AionCore）

| 文件 | 改动 |
|------|------|
| `crates/aionui-db/src/repository/provider.rs` | trait 增加 `find_by_model` 默认方法（返回 `None`） |
| `crates/aionui-db/src/repository/sqlite_provider.rs` | 实现 `find_by_model`：忽略 user_id，匹配任意 `enabled=1` 且 `models` 含目标模型名的 provider 行 |
| `crates/aionui-ai-agent/src/factory/aionrs.rs` | `find_by_id` 失败时回退 `find_by_model`，解决免登录下 `Provider 'aionrs' not found` |

原因：aionrs 内置团队 agent 的 provider 行（`id='aionrs'`）只在登录后由服务器下发；本地/离线模式不存在该行，硬查会报错。回退方案不伪造任何数据，只复用本机已启用的真实 provider 配置。

## 云端构建

推送到 main 或手动触发 `Build AionUi local installer (Windows x64)` workflow：

1. `cargo build --release --target x86_64-pc-windows-msvc` 编译 aioncore.exe（windows-latest + MSVC）
2. `aioncore.exe prepare-managed-resources` 生成自包含 bundle
3. `bun install` + `AIONUI_BACKEND_LOCAL_BUNDLE_DIR=<bundle>` 注入本地 bundle（不下载官方 exe）
4. `electron-builder` 产出 NSIS 安装包
5. 产物上传为 artifact `AionUi-local-win-x64`（保留 30 天）

## 与登录挂钩、去登录后的行为

- ✅ 可用：启动直进主界面、后端 Local 身份（`system_default_user`）、单人对话、团队多智能体（靠 find_by_model 回退）、历史聊天、Sentry 遥测（匿名设备 UUID，与账户无关）
- ⚠️ 仅 WebUI 模式受影响：管理员密码 / QR 登录（远程访问才需要，桌面版不涉及）
- ❌ 不在范围：多端同步、云端空间等远程账号服务
- 与应用登录无关、保留不动：MCP OAuth、模型 provider OAuth（Claude/Google 登录）、微信渠道登录、Sentry

## 免责声明

本项目修改了原软件的认证与 provider 解析逻辑，仅用于个人本地自由使用。使用者需自行承担相关风险，并遵守所在地法律法规。
