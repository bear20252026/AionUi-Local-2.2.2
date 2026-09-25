# patches/ — 免登录补丁（升级时重放）

上游新版发布后，用这些补丁一键重放，无需手工重改 4 处。

## 补丁清单

| 文件 | 上游基线 | 内容 |
|------|----------|------|
| `aioncore-v0.2.2-no-login.patch` | iOfficeAI/AionCore v0.2.2 | provider `find_by_model` 全局回退（3 个文件）：trait 默认方法 + sqlite 实现 + aionrs 工厂回退 |
| `aionui-v2.2.2-auth-bypass.patch` | iOfficeAI/AionUi v2.2.2 | `AuthContext.tsx` 硬编码 `isDesktopRuntime = true`（任何运行时都不跳 /login） |

## 升级步骤（上游出新版时）

```bash
# 1. 同步上游到 AionUi/ 与 AionCore/（或重新 clone 对应新 tag）
# 2. 打补丁
cd AionCore && git apply ../patches/aioncore-<新版本>-no-login.patch   # 冲突时按 hunk 手工合
cd AionUi   && git apply ../patches/aionui-<新版本>-auth-bypass.patch

# 3. 后端类型检查（改了 rust）
cd AionCore && cargo check -p aionui-db -p aionui-ai-agent

# 4. 提交并推送 → GitHub Actions 自动产出：
#    - Windows 安装包 (build-win-installer.yml)
#    - Linux 网页版 tarball (build-linux-web.yml)

# 5. 网页版更新到服务器：
#    gh run download <run-id> -n aionui-web-linux-x64 -D ./dl
#    scp dl/*.tar.gz root@101.133.235.110:/opt/aionui-web/
#    ssh root@101.133.235.110 'cd /opt/aionui-web && tar -xzf *.tar.gz && pm2 restart aionui-web'
```

## 注意

- 上游若改动了补丁所在函数（尤其 `aionrs.rs` 的 provider 查找段落），`git apply` 会报冲突——按补丁语义（"find_by_id 失败则按模型名回退到任意已启用 provider"）手工合并。
- 重放后**同步更新本目录补丁**（`git diff > patches/xxx.patch`），保持与线上一致。
