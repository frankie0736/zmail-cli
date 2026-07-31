# Phase 0 Spike

验证 Zoho Mail API 的真实行为。**四项结论全部产出前不进入 Phase 1**（见实施计划 §25）。

零依赖，直接用 Node 22 跑，不需要 `npm install`。

---

## 一次性准备：注册 Zoho OAuth 应用

1. 打开 https://api-console.zoho.com/ ，用你的 Zoho Mail 账号登录。
2. 点 **ADD CLIENT** → 选 **Server-based Applications**。
3. 填写：

   | 字段 | 填什么 |
   |---|---|
   | Client Name | `zmail-cli-spike` |
   | Homepage URL | `https://github.com/frankie0736/zmail-cli` |
   | **Authorized Redirect URIs** | `http://127.0.0.1:53682/oauth/callback` |

   > 回调地址必须**一字不差**，否则 Zoho 直接报 `redirect_uri_mismatch`。
   > 如果 Zoho 拒绝 `http://127.0.0.1`（而不是 `localhost`），把这个结果记下来——
   > 这正是 Phase 0-1 要回答的问题之一，会决定是否降级到 Device Flow 或 Self Client。

4. 创建后拿到 **Client ID** 和 **Client Secret**。

5. 写进 `spikes/.secrets.json`（该文件已 gitignore）：

   ```json
   {
     "clientId": "1000.XXXXXXXXXXXXXXXXXXXXXXXX",
     "clientSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
     "location": "com"
   }
   ```

   也可以用环境变量代替：`ZMAIL_CLIENT_ID` / `ZMAIL_CLIENT_SECRET` / `ZMAIL_LOCATION`。

   `location` 取值：`com`（国际）/ `eu` / `in` / `com.cn` / `com.au` / `jp`。

---

## 执行顺序

```bash
# 0-1  OAuth loopback 授权，拿 refresh token
node spikes/01-oauth.mjs

# 0-1b 验证「重启进程后仅凭 refresh token 可用」
node spikes/01-oauth.mjs --refresh

# 0-6  账户身份 / alias / 邮箱规模 / IMAP 可用性 / ID 类型
node spikes/02-account.mjs
```

**先跑 0-6**（即 `02-account.mjs`）的理由：它只需要一次 API 调用，却能同时校准
0-2 的配额推算，并直接决定 0-4 的 IMAP 探测是否值得做。

后续脚本（`03-quota.mjs` / `04-imap.mjs` / `05-fixtures.mjs`）会在 0-6 有结论后补上——
因为它们的设计取决于 0-6 报告的邮箱规模和 IMAP 开关。

---

## 产物

全部写到 `spikes/out/`（已 gitignore）：

| 文件 | 内容 | 能否公开 |
|---|---|---|
| `findings-0-1.json` | OAuth 流程结论 | ✅ 可摘录进 `docs/phase-0-findings.md` |
| `findings-0-6.json` | 身份 / 规模 / IMAP / ID 类型结论 | ✅ 同上 |
| `fixture-account-detail.json` | **已脱敏**的账户响应 | ✅ 复核后可作为 MockZohoServer 数据源 |
| `fixture-account-detail.raw.json` | **未脱敏**原始响应 | ❌ 仅本地比对，绝不提交 |
| `redaction-mapping.json` | 真实地址 → 假地址映射 | ❌ 绝不提交 |

脱敏采用**一致性替换**：同一个真实地址永远映射到同一个假地址，
所以线程关系、收发结构、alias 命中在 fixture 里依然成立。

把 fixture 提交进仓库前，**人工过一遍** `redaction-mapping.json`，
确认没有漏网的真实地址、人名或公司名。

---

## 安全说明

- `.secrets.json` 权限 0600，已 gitignore。这是 spike 的临时方案；
  正式版凭据进 Keychain / FileSecretStore（实施计划 §9）。
- Access token 只在进程内存中，不落盘。
- 本地回调服务只绑 `127.0.0.1`，每次授权生成随机 `state` 并强制校验，
  成功或超时后立即关闭。
- 所有日志走 stderr，不含 token、secret 和邮件正文。

跑完 spike 后，如果暂时不继续，建议到
https://accounts.zoho.com/home#sessions/userconnectedapps
撤销这个应用的授权。

---

## 排错

| 现象 | 原因 |
|---|---|
| `redirect_uri_mismatch` | Console 里的回调地址与 `http://127.0.0.1:53682/oauth/callback` 不完全一致 |
| `invalid_client` | Client ID/Secret 不匹配，或数据中心选错（试 `ZMAIL_LOCATION=eu`） |
| 拿不到 `refresh_token` | Zoho 对同一 client 的重复授权不再返回。到「已连接应用」撤销后重试 |
| 账户列表为空 | scope 缺 `ZohoMail.accounts.READ` |
| 文件夹接口 403 | 只读 scope 不足以列文件夹——**这本身就是一条重要结论**，记进 findings |
| 端口 53682 被占用 | `lsof -i :53682` 查一下 |
