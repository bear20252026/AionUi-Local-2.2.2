# patches/ — 补丁存档（升级时重放）

CI（`../.github/workflows/build-*.yml`）**直接构建仓库内的 `AionUi/`、`AionCore/` 源码树**，本目录只是源码树相对上游 tag 的 diff 存档。改动源码树后必须同步重导出补丁：

```bash
# 上游 clone（../../AionUi、../../AionCore）保持"tag + 全部补丁已应用"的镜像态，
# 重导出 = 直接 git diff（新建文件需先 git add -N 才会进 diff）：
git -C ../../AionCore add -N crates/aionui-system/tests/admin_routes.rs
git -C ../../AionCore diff -- crates/aionui-ai-agent/src/factory/aionrs.rs \
      crates/aionui-db/src/repository/provider.rs crates/aionui-db/src/repository/sqlite_provider.rs \
  > patches/aioncore-v0.2.2-no-login.patch
git -C ../../AionCore diff -- crates/ \
      ':(exclude)crates/aionui-ai-agent/src/factory/aionrs.rs' \
      ':(exclude)crates/aionui-db/src/repository/provider.rs' \
      ':(exclude)crates/aionui-db/src/repository/sqlite_provider.rs' \
  > patches/aioncore-v0.2.2-admin-api.patch
git -C ../../AionUi add -N packages/desktop/src/renderer/admin.html \
      packages/desktop/src/renderer/admin.tsx packages/desktop/src/renderer/pages/admin \
      packages/desktop/src/renderer/services/i18n/locales/*/admin.json \
      tests/unit/renderer/hooks/useConversationListSyncIdentity.dom.test.tsx
git -C ../../AionUi diff > patches/aionui-v2.2.2-multiuser.patch

# 校验（必须在干净 tag 上通过，再与 monorepo 逐文件比对）
git -C ../../AionCore reset --hard && git -C ../../AionCore clean -fd
git -C ../../AionCore apply --check patches/aioncore-v0.2.2-no-login.patch patches/aioncore-v0.2.2-admin-api.patch
git -C ../../AionUi reset --hard && git -C ../../AionUi clean -fd
git -C ../../AionUi apply --check patches/aionui-v2.2.2-multiuser.patch
```

> monorepo 工作区是 **CRLF**、上游 clone 索引是 **LF**：把 monorepo 文件拷进 clone 做镜像时
> 必须先转 LF（`sed -i 's/\r$//'`），否则整树都是假差异。

> 若上游 clone 不是镜像态（`git -C ../../AionUi status` 不显示补丁改动），把 monorepo 源码树里
> 的差异文件拷入 clone 工作区后再 diff。拷入的文本文件先 `sed -i 's/\r$//'` 转 LF。

## 补丁清单

| 文件 | 上游基线 | 内容 | 用途 |
|------|----------|------|------|
| `aioncore-v0.2.2-no-login.patch` | iOfficeAI/AionCore v0.2.2 | provider `find_by_model` 回退（3 个文件）：trait 默认方法 + sqlite 实现（`WHERE enabled=1 AND user_id=?`，**严格限请求者本人**）+ aionrs 工厂回退 | 桌面 + 网页，必打 |
| `aioncore-v0.2.2-admin-api.patch` | 同上（叠打在 no-login 之上） | Web 管理控制台后端（15 个文件）：`aionui-system/routes.rs` admin **用户管理 API（建号 / 重置密码 / 停用启用）** + Provider 管理 API、`aionui-api-types`（auth.rs/lib.rs）类型、`aionui-app/router/state.rs` 装配、`aionui-db/lib.rs` 导出 `User`、**`aionui-auth` 登录拒绝已停用账号**（routes.rs + tests/route_tests.rs）、`tests/admin_routes.rs`（新增）及 7 个既有路由测试补 user repo 夹具 | 网页版多用户（管理控制台） |
| `aionui-v2.2.2-multiuser.patch` | iOfficeAI/AionUi v2.2.2 | ① `web-host/backend-launcher.ts`：`--local` 硬编码改 `AIONUI_MULTIUSER` 开关（默认关 = 上游单用户）；② CSRF 双提交补齐（httpBridge 读 `aionui-csrf-token` cookie 给状态变更请求附 `x-csrf-token`，sessionRefresh/configService/AuthContext/FileService/SpeechToText 同步附头，含回归测试）；③ 浏览器登录门 + login 页多用户引导；④ Web 管理控制台前端：`renderer/admin.html/admin.tsx`、`pages/admin/`（AdminApp 等）、`/admin` 直出（web-host static-server + electron.vite 入口）、静态资源确定性缓存头；⑤ 控制台 13 语言 i18n（`locales/*/admin.json` + index.ts 注册 + i18n-keys.d.ts）；⑥ 切换账号清空会话列表防串号；⑦ 多用户首启密码失败告警（scripts/webui.ts、resetpass.ts）；⑧ 控制台用户开通前端（新建用户 / 重置密码 / 停用启用对话框，`AdminApp.tsx`）；⑨ 侧栏"管理控制台"入口（`SiderFooter`/`Sider`，仅浏览器 WebUI 显示，文案 `common.adminConsole` ×13 语言） | 网页版多用户，必打 |
| `aionui-v2.2.2-auth-bypass.patch` | iOfficeAI/AionUi v2.2.2 | `AuthContext.tsx` 硬编码 `isDesktopRuntime = true`（任何运行时不跳 /login） | **仅**"网页免登录"部署；与 multiuser 补丁**互斥**（都改 AuthContext.tsx），多用户部署**禁用** |

行为速查：

- 桌面 exe：`window.electronAPI` 恒在 → 永不登录（auth-bypass 可打可不打；admin API 在桌面端无入口，无副作用）。
- 网页 tarball：不打 auth-bypass + 不设 `AIONUI_MULTIUSER` → 登录门 + 单用户共享数据（上游原生行为）。
- 网页 tarball：不打 auth-bypass + 打 admin-api/admin 控制台补丁 + `AIONUI_MULTIUSER=1` → 登录门 + 按用户隔离数据 + `/admin` 管理控制台（多用户模式，当前生产形态）。

## 升级步骤（上游出新版时）

```bash
# 0. 重放环境务必关闭行尾转换（CRLF 工作区会让 LF 补丁 "patch does not apply"）：
git config core.autocrlf false && git checkout -f -- . && git clean -fd

# 1. 同步上游到 AionUi/ 与 AionCore/（或重新 clone 对应新 tag）
# 2. 打补丁（顺序固定）
cd AionCore && git apply ../patches/aioncore-v0.2.2-no-login.patch
cd AionCore && git apply ../patches/aioncore-v0.2.2-admin-api.patch   # 多用户部署；纯桌面免登录可跳过
cd AionUi   && git apply ../patches/aionui-v2.2.2-multiuser.patch     # 多用户部署；免登录部署改用 auth-bypass（互斥）

# 3. 校验补丁能干净应用（对干净基线）
git apply --check ../patches/xxx.patch

# 4. 后端类型检查（改了 rust）
cd AionCore && cargo check -p aionui-db -p aionui-ai-agent -p aionui-system

# 5. 提交并推送 → GitHub Actions 自动产出：
#    - Windows 安装包 (build-win-installer.yml)
#    - Linux 网页版 tarball (build-linux-web.yml)

# 6. 网页版更新到服务器：
#    gh run download <run-id> -n aionui-web-linux-x64 -D ./dl
#    scp dl/*.tar.gz root@101.133.235.110:/opt/aionui-web/
#    ssh root@101.133.235.110 'cd /opt/aionui-web && tar -xzf *.tar.gz && pm2 restart aionui-web'
#    多用户模式另见 ../README.md「网页版多用户操作手册」（AIONUI_MULTIUSER=1）
```

## 注意

- 上游若改动了补丁所在函数（尤其 `aionrs.rs` 的 provider 查找段落、`routes.rs`、`httpBridge.ts`），`git apply` 会报冲突——按补丁语义手工合并：
  - no-login："find_by_id 失败则回退到请求者自己名下按模型名匹配的已启用 provider"；
  - admin-api：`/api/admin/*` 仅管理员（JWT identity_mode=webui）可达；
  - multiuser：`AIONUI_MULTIUSER` 开关 + CSRF 双提交 + `/admin` 直出。
- 重放后**同步重导出本目录补丁**，保持与源码树一致。
- 导出补丁务必用 bash 重定向（`git diff > x.patch`，UTF-8 + LF）。PowerShell 的 `>` 会产出 UTF-16/CRLF，`git apply` 直接报 "No valid patches in input"（auth-bypass 补丁曾中招，已修复）。
- 补丁为 LF 行尾、不含二进制：monorepo 源码树相对上游还**缺少** `resources/*.gif`（16 个 README 演示图，约 300MB，仓库瘦身删除，不影响构建）与 `resources/windows/support/_sentry-dsn.generated.nsh`（构建生成物，上游 .gitignore 忽略）——重放时无需补回。
- 补丁校验/应用统一用 `git apply`；若目标工作区为 CRLF（Windows 默认 autocrlf=true），先按「升级步骤 0」处理。
