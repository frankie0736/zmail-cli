/**
 * 极简 IMAP 客户端，仅供 Phase 0-4 探测使用。
 *
 * 零依赖，直接走 node:tls。这**不是**完整的 IMAP 实现，也不打算是 ——
 * 目标只是回答「Zoho 的 IMAP + XOAUTH2 能否用于批量同步」。
 *
 * ## 安全约束（操作的是真实邮箱）
 *
 *   - 只用 EXAMINE，绝不用 SELECT：EXAMINE 以只读方式打开邮箱
 *   - 只用 BODY.PEEK[]，绝不用 BODY[]：后者会把邮件标记为已读
 *   - 不发送任何 STORE / EXPUNGE / APPEND
 *
 * 违反前两条会在用户的真实邮箱里留下痕迹，这是不可接受的副作用。
 */

import { connect } from "node:tls";

const CRLF = "\r\n";

export class ImapProbe {
  #socket;
  #buffer = "";
  /** @type {Map<string, {resolve: Function, reject: Function, lines: string[]}>} */
  #pending = new Map();
  #tagCounter = 0;
  #untagged = [];
  #greeting = null;

  /**
   * @param {{host: string, port?: number, timeoutMs?: number}} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port ?? 993;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`连接 ${this.host}:${this.port} 超时`)),
        this.timeoutMs,
      );

      this.#socket = connect({ host: this.host, port: this.port, servername: this.host }, () => {
        // 等服务器问候（* OK ...）
      });

      this.#socket.setEncoding("utf8");
      this.#socket.on("data", (chunk) => this.#onData(chunk));
      this.#socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      const onGreeting = (line) => {
        if (line.startsWith("* OK") || line.startsWith("* PREAUTH")) {
          clearTimeout(timer);
          this.#greeting = line;
          this.#onGreeting = null;
          resolve(line);
        } else if (line.startsWith("* BYE")) {
          clearTimeout(timer);
          reject(new Error(`服务器拒绝连接: ${line}`));
        }
      };
      this.#onGreeting = onGreeting;
    });
  }

  #onGreeting = null;

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const idx = this.#buffer.indexOf(CRLF);
      if (idx < 0) break;
      const line = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 2);
      this.#onLine(line);
    }
  }

  #onLine(line) {
    if (this.#onGreeting) {
      this.#onGreeting(line);
      return;
    }

    // 带 tag 的结束行： "A003 OK ..." / "A003 NO ..." / "A003 BAD ..."
    const tagged = /^([A-Z]\d+) (OK|NO|BAD) ?(.*)$/.exec(line);
    if (tagged) {
      const [, tag, status, text] = tagged;
      const waiter = this.#pending.get(tag);
      if (waiter) {
        this.#pending.delete(tag);
        const result = { status, text, lines: waiter.lines, untagged: this.#untagged };
        this.#untagged = [];
        if (status === "OK") waiter.resolve(result);
        else waiter.reject(Object.assign(new Error(`${status}: ${text}`), { result }));
      }
      return;
    }

    // continuation（AUTHENTICATE 时服务器要求继续）
    if (line.startsWith("+")) {
      for (const waiter of this.#pending.values()) waiter.onContinuation?.(line);
      return;
    }

    this.#untagged.push(line);
    for (const waiter of this.#pending.values()) waiter.lines.push(line);
  }

  /**
   * 发送一条命令并等待其 tagged 响应。
   * @param {string} command
   * @param {{onContinuation?: (line: string) => void}} [opts]
   */
  send(command, opts = {}) {
    const tag = `A${String(++this.#tagCounter).padStart(3, "0")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(tag);
        reject(new Error(`命令超时: ${command.split(" ")[0]}`));
      }, this.timeoutMs);

      this.#pending.set(tag, {
        lines: [],
        onContinuation: opts.onContinuation,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.#socket.write(`${tag} ${command}${CRLF}`);
    });
  }

  /** 原始写入，用于 AUTHENTICATE 的 continuation。 */
  writeRaw(text) {
    this.#socket.write(`${text}${CRLF}`);
  }

  get greeting() {
    return this.#greeting;
  }

  async logout() {
    try {
      await this.send("LOGOUT");
    } catch {
      // 断开阶段的错误不重要
    }
    this.#socket?.end();
    this.#socket?.destroy();
  }
}

/**
 * 构造 SASL XOAUTH2 初始响应。
 *
 * 格式：base64("user=" + email + "\x01auth=Bearer " + token + "\x01\x01")
 */
export function xoauth2Token(email, accessToken) {
  return Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`, "utf8").toString(
    "base64",
  );
}

/** 从 EXAMINE 的响应里抽取同步所需的关键字段。 */
export function parseExamine(lines) {
  const out = { exists: null, uidValidity: null, uidNext: null, flags: null, readOnly: false };
  for (const line of lines) {
    const exists = /^\* (\d+) EXISTS/.exec(line);
    if (exists) out.exists = Number(exists[1]);

    // UIDVALIDITY / UIDNEXT 保持字符串：它们是 32 位无符号数，
    // 虽然目前不会溢出，但没有任何理由把它们当数字用。
    const uidValidity = /UIDVALIDITY (\d+)/.exec(line);
    if (uidValidity) out.uidValidity = uidValidity[1];

    const uidNext = /UIDNEXT (\d+)/.exec(line);
    if (uidNext) out.uidNext = uidNext[1];

    const flags = /^\* FLAGS \((.*)\)/.exec(line);
    if (flags) out.flags = flags[1]?.split(" ") ?? null;

    if (/\[READ-ONLY\]/.test(line)) out.readOnly = true;
  }
  return out;
}
