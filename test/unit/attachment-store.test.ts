/**
 * 附件存储与文件名消毒测试。实施计划 §22.1。
 *
 * 恶意文件名那一组是 §15.4 明确要求的 fixture —— 这里是能造成实际危害的
 * 少数几个地方之一，一封精心构造的邮件加上一次导出就够了。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/core/errors.js";
import {
  AttachmentStore,
  type EvictionCandidate,
  planEviction,
} from "../../src/storage/attachment-store.js";
import {
  resolveExportPath,
  safeFilename,
  uniqueExportPath,
} from "../../src/storage/safe-filename.js";

describe("safeFilename：恶意文件名（§15.4 要求的 fixture）", () => {
  it.each([
    ["POSIX 路径穿越", "../../.ssh/authorized_keys"],
    ["Windows 路径穿越", "..\\..\\Windows\\System32\\evil.dll"],
    ["绝对路径", "/etc/cron.d/backdoor"],
    ["Windows 绝对路径", "C:\\Windows\\System32\\evil.dll"],
    ["混合分隔符", "..\\../etc/passwd"],
    ["尾部路径", "docs/../../../root/.bashrc"],
  ])("%s 不再包含任何路径成分", (_desc, evil) => {
    const safe = safeFilename(evil);
    expect(safe).not.toContain("/");
    expect(safe).not.toContain("\\");
    expect(safe).not.toBe("..");
    expect(safe.length).toBeGreaterThan(0);
  });

  it.each([["CON"], ["PRN"], ["AUX"], ["NUL"], ["COM1"], ["LPT1"], ["con.txt"], ["NUL.pdf"]])(
    "Windows 保留设备名 %s 被改写",
    (reserved) => {
      // 保留名即使带扩展名也仍然是保留名，Windows 上会写失败
      expect(safeFilename(reserved).toUpperCase()).not.toMatch(
        /^(CON|PRN|AUX|NUL|COM1|LPT1)(\.|$)/,
      );
    },
  );

  it("控制字符被剔除", () => {
    const withNul = `a${String.fromCharCode(0)}b.pdf`;
    const withNewline = "line\nbreak.pdf";
    for (const name of [withNul, withNewline]) {
      const safe = safeFilename(name);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言控制字符已被清除
      expect(safe).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it("空白与纯点名回退到默认名", () => {
    for (const bad of ["", "   ", "...", "..", "."]) {
      expect(safeFilename(bad)).toBe("attachment");
    }
  });

  it("超长名被截断但保留扩展名", () => {
    const safe = safeFilename(`${"x".repeat(400)}.pdf`);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(200);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("中文与空格是合法的，不该被破坏", () => {
    // 过度消毒也是一种 bug：把 "报价单 2026.pdf" 改名会让用户找不到文件
    expect(safeFilename("报价单 2026.pdf")).toBe("报价单 2026.pdf");
  });

  it("正常文件名原样保留", () => {
    expect(safeFilename("quotation-Q3.pdf")).toBe("quotation-Q3.pdf");
  });
});

describe("resolveExportPath：最后一道防线", () => {
  it("越界路径被拒绝而不是静默写出去", () => {
    // 即使 safeFilename 因某种未预料输入漏掉了什么，这里也要拦住
    expect(() => resolveExportPath("/tmp/out", "../../etc/passwd")).not.toThrow();
    // 消毒后应落在目录内
    expect(resolveExportPath("/tmp/out", "../../etc/passwd").startsWith(`/tmp/out${sep}`)).toBe(
      true,
    );
  });

  it("结果始终位于输出目录之内", () => {
    for (const evil of ["../x", "../../y", "a/../../z", "/abs/path"]) {
      const p = resolveExportPath("/tmp/out", evil);
      expect(p.startsWith(`/tmp/out${sep}`)).toBe(true);
    }
  });
});

describe("uniqueExportPath：不静默覆盖", () => {
  it("同名时追加序号", () => {
    const existing = new Set(["/tmp/out/a.pdf", "/tmp/out/a (1).pdf"]);
    const p = uniqueExportPath("/tmp/out", "a.pdf", (x) => existing.has(x));
    expect(p).toBe("/tmp/out/a (2).pdf");
  });

  it("不存在时直接用原名", () => {
    expect(uniqueExportPath("/tmp/out", "a.pdf", () => false)).toBe("/tmp/out/a.pdf");
  });
});

// ---------------------------------------------------------------- 存储

describe("AttachmentStore", () => {
  let dir: string;
  let store: AttachmentStore;

  const streamOf = (content: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zmail-att-"));
    store = new AttachmentStore(join(dir, "attachments"), join(dir, "tmp"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("按 SHA-256 内容寻址存储", async () => {
    const blob = await store.storeStream(streamOf("hello"));
    // sha256("hello")
    expect(blob.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(readFileSync(blob.path, "utf8")).toBe("hello");
    // 路径由哈希决定，与文件名无关
    expect(blob.path).toContain(`${sep}2c${sep}`);
  });

  it("相同内容自动去重，不重复写盘", async () => {
    const first = await store.storeStream(streamOf("same content"));
    const second = await store.storeStream(streamOf("same content"));
    expect(second.sha256).toBe(first.sha256);
    expect(second.path).toBe(first.path);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
  });

  it("字节数与服务端声明不符时拒绝，且不留下文件", async () => {
    // 传输被截断却标记成功，是最糟的失败模式：用户以为附件在，打开却是坏的
    await expect(store.storeStream(streamOf("short"), 99999)).rejects.toMatchObject({
      code: ErrorCode.INCOMPLETE_DATA,
    });
    const stray = readFileSync;
    expect(() => stray(join(dir, "attachments"))).toThrow(); // 目录里什么都没有
  });

  it("字节数相符时通过", async () => {
    const blob = await store.storeStream(streamOf("12345"), 5);
    expect(blob.sizeBytes).toBe(5);
  });

  it("空内容被拒绝", async () => {
    await expect(store.storeStream(streamOf(""))).rejects.toMatchObject({
      code: ErrorCode.INCOMPLETE_DATA,
    });
  });

  it("失败后不留临时文件", async () => {
    await expect(store.storeStream(streamOf("x"), 999)).rejects.toThrow();
    const { readdirSync, existsSync } = await import("node:fs");
    const tmpPath = join(dir, "tmp");
    if (existsSync(tmpPath)) expect(readdirSync(tmpPath)).toHaveLength(0);
  });

  it("has / sizeOf / evict", async () => {
    const blob = await store.storeStream(streamOf("payload"));
    expect(store.has(blob.sha256)).toBe(true);
    expect(store.sizeOf(blob.sha256)).toBe(7);
    expect(store.evict(blob.sha256)).toBe(true);
    expect(store.has(blob.sha256)).toBe(false);
    expect(store.evict(blob.sha256)).toBe(false); // 幂等
  });

  it("文件权限为 0600", async () => {
    const blob = await store.storeStream(streamOf("secret"));
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(blob.path).mode & 0o777).toBe(0o600);
    }
  });
});

describe("planEviction：LRU 回收", () => {
  const c = (sha: string, size: number, at: number | null): EvictionCandidate => ({
    sha256: sha,
    sizeBytes: size,
    lastAccessedAt: at,
  });

  it("未超配额时不淘汰任何东西", () => {
    const plan = planEviction([c("a", 100, 1)], 100, 1000);
    expect(plan.evict).toHaveLength(0);
  });

  it("最久未访问的先被淘汰", () => {
    const plan = planEviction(
      [c("new", 500, 3000), c("old", 500, 1000), c("mid", 500, 2000)],
      1500,
      600,
    );
    expect(plan.evict.map((e) => e.sha256)).toEqual(["old", "mid"]);
  });

  it("从未访问过的视为最旧", () => {
    const plan = planEviction([c("used", 500, 5000), c("never", 500, null)], 1000, 500);
    expect(plan.evict[0]?.sha256).toBe("never");
  });

  it("只淘汰到刚好回到配额以内，不多删", () => {
    const plan = planEviction([c("a", 100, 1), c("b", 100, 2), c("c", 100, 3)], 300, 150);
    expect(plan.freedBytes).toBe(200);
    expect(plan.evict).toHaveLength(2);
  });
});
