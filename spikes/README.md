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

# 0-2  API 配额与速率限制 ⚠️ 消耗真实配额
node spikes/03-quota.mjs

# 0-4  IMAP + XOAUTH2 可行性
node spikes/04-imap.mjs
```

**顺序是有依赖的，不要打乱：**

`02-account.mjs` 必须在 `03` 和 `04` 之前跑。它一次调用就能产出四项结论，
其中两项直接影响后面的脚本：

- `usedStorage` → `03` 用它推算全量同步成本，不用瞎猜
- `imapAccessEnabled` → `04` 读到 IMAP 未启用时会**直接跳过并退出**，省下 2 小时

`03-quota.mjs` 也应在 `04` 之前，这样 `04` 才能给出 REST vs IMAP 的对比推算。

### 各脚本的额外参数

```bash
node spikes/03-quota.mjs --budget 300     # 放宽调用预算（默认 120）
node spikes/03-quota.mjs --probe-429      # 探测限流阈值（会被短暂限流）
node spikes/04-imap.mjs --fetch 20        # 批量取正文的样本数（默认 10）
```

---

## ⚠️ 这两个脚本会碰你的真实资源

### `03-quota.mjs` 消耗真实 API 配额

它的目的就是测出配额，所以必然要花配额。防护措施：

- 默认硬上限 **120 次调用**，超出立即停止
- 每次调用都计数，结论随时可落盘
- `Ctrl+C` 会保存已获得的部分结论，不会白跑
- 429 阈值探测**默认关闭**，需要显式加 `--probe-429`——开启后你会被
  短暂限流，正常使用可能受影响几分钟

跑完后请到 Zoho 控制台查你套餐的每日 API 上限，手工填进
`findings-0-2.json` 的 `dailyQuota` 字段。脚本测不出这个数字，只能测出速率。

### `04-imap.mjs` 访问你的真实邮箱

已在代码层面强制只读，并有测试守护：

| 约束 | 原因 |
|---|---|
| 只用 `EXAMINE`，绝不用 `SELECT` | `EXAMINE` 以只读方式打开邮箱 |
| 只用 `BODY.PEEK[]`，绝不用 `BODY[]` | 后者会把邮件**标记为已读** |
| 不发送 `STORE` / `EXPUNGE` / `APPEND` | 任何写操作都会在真实邮箱留下痕迹 |

这三条有专门的断言：测试会检查整个会话里实际发出的命令，出现上述任一
禁止命令即失败。

---

## 结论会反向修订实施计划

这不是走过场的验证，两项结论可能推翻已有设计：

**`03-quota.mjs`**——当前设计是每封邮件一次正文请求。如果每日配额撑不住，
必须修订 §3.1（MVP 目标）、§8.4（默认只同步最近 N 个月）、§14（跨天续传）。

**`04-imap.mjs`**——如果 IMAP + XOAUTH2 可用且 UID 增量同步成立，
§4 的「不做通用 IMAP 客户端」这条非目标需要重新考虑，§14.3 的 400 封重叠
扫描和 §14.7 的对账逻辑可以大幅简化。注意结论**不是**推翻 REST——REST 在
thread、label、草稿、发送上仍然更好，可能的结论是混合方案。

跑完四个脚本后，把结论汇总进 `docs/phase-0-findings.md`，然后我们回头改
实施计划，再开始 Phase 2。

---

## 产物

全部写到 `spikes/out/`（已 gitignore）：

| 文件 | 内容 | 能否公开 |
|---|---|---|
| `findings-0-1.json` | OAuth 流程结论 | ✅ 可摘录进 `docs/phase-0-findings.md` |
| `findings-0-6.json` | 身份 / 规模 / IMAP / ID 类型结论 | ✅ 同上 |
| `findings-0-2.json` | 配额、分页上限、并发与限流结论 | ✅ 同上 |
| `findings-0-4.json` | IMAP 可行性与 REST 对比 | ✅ 同上 |
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
