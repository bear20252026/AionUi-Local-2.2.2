# patches/ — 补丁存档（升级时重放）

CI（`../.github/workflows/build-*.yml`）**直接构建仓库内的 `AionUi/`、`AionCore/` 源码树**，本目录只是源码树相对上游 tag 的 diff 存档。改动源码树后必须同步重导出补丁：

```bash
git -C AionUi   diff > patches/aionui-v2.2.2-multiuser.patch     # （按实际改动文件选择）
git -C AionCore diff > patches/aioncore-v0.2.2-no-login.patch
```

## 补丁清单

| 文件 | 上游基线 | 内容 | 用途 |
|------|----------|------|------|
| `aioncore-v0.2.2-no-login.patch` | iOfficeAI/AionCore v0.2.2 | provider `find_by_model` 回退（3 个文件）：trait 默认方法 + sqlite 实现（`WHERE enabled=1 AND user_id=?`，**严格限请求者本人**）+ aionrs 工厂回退 | 桌面 + 网页，必打 |
| `aionui-v2.2.2-multiuser.patch` | iOfficeAI/AionUi v2.2.2 | `web-host/src/backend-launcher.ts`：`--local` 硬编码改为 `AIONUI_MULTIUSER` 环境变量开关（默认关 = 上游单用户） | 网页版多用户 |
| `aionui-v2.2.2-auth-bypass.patch` | iOfficeAI/AionUi v2.2.2 | `AuthContext.tsx` 硬编码 `isDesktopRuntime = true`（任何运行时不跳 /login） | **仅**"网页免登录"部署；多用户部署**禁用**（进了不了登录页），桌面版打不打行为都一样 |

行为速查：

- 桌面 exe：`window.electronAPI` 恒在 → 永不登录（auth-bypass 可打可不打）。
- 网页 tarball：不打 auth-bypass + 不设 `AIONUI_MULTIUSER` → 登录门 + 单用户共享数据（上游原生行为）。
- 网页 tarball：不打 auth-bypass + `AIONUI_MULTIUSER=1` → 登录门 + 按用户隔离数据（多用户模式）。

## 升级步骤（上游出新版时）

```bash
# 1. 同步上游到 AionUi/ 与 AionCore/（或重新 clone 对应新 tag）
# 2. 打补丁
cd AionCore && git apply ../patches/aioncore-<新版本>-no-login.patch   # 冲突时按 hunk 手工合
cd AionUi   && git apply ../patches/aionui-<新版本>-multiuser.patch    # 多用户部署；免登录部署改用 auth-bypass

# 3. 校验补丁能干净应用（对干净基线）
git apply --check ../patches/xxx.patch

# 4. 后端类型检查（改了 rust）
cd AionCore && cargo check -p aionui-db -p aionui-ai-agent

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

- 上游若改动了补丁所在函数（尤其 `aionrs.rs` 的 provider 查找段落），`git apply` 会报冲突——按补丁语义（"find_by_id 失败则回退到请求者自己名下按模型名匹配的已启用 provider"）手工合并。
- 重放后**同步重导出本目录补丁**，保持与源码树一致。
- 导出补丁务必用 bash 重定向（`git diff > x.patch`，UTF-8 + LF）。PowerShell 的 `>` 会产出 UTF-16/CRLF，`git apply` 直接报 "No valid patches in input"（auth-bypass 补丁曾中招，已修复）。
