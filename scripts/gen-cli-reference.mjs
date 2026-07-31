#!/usr/bin/env node
/**
 * 从 CLI 自身生成命令参考。
 *
 * 手写的命令文档一定会漂移 —— 加了个 flag 忘了更新文档，Agent 就按过时的
 * 说明构造命令然后失败。让文档由实现生成，漂移就不可能发生。
 *
 * 注意：help 输出走的是 **stderr**，因为 --json 下 stdout 只允许有业务结果
 * （§17.3）。只读 stdout 会得到一片空白。
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const help = (args) => {
  const r = spawnSync("node", ["--import", "tsx", "src/cli.ts", ...args, "--help"], {
    encoding: "utf8",
  });
  // help 在 stderr；两边都取，谁有内容用谁
  return (r.stderr || r.stdout || "").trim();
};

const GROUPS = [
  { args: [], title: "zmail" },
  { args: ["auth"], title: "zmail auth" },
  { args: ["sync"], title: "zmail sync" },
  { args: ["search"], title: "zmail search" },
  { args: ["message"], title: "zmail message" },
  { args: ["thread"], title: "zmail thread" },
  { args: ["folder"], title: "zmail folder" },
  { args: ["attachment"], title: "zmail attachment" },
  { args: ["export"], title: "zmail export" },
  { args: ["data"], title: "zmail data" },
  { args: ["config"], title: "zmail config" },
  { args: ["doctor"], title: "zmail doctor" },
];

let out = `# CLI reference

Generated from the CLI itself. If this drifts from the implementation, the
implementation wins — regenerate with \`node scripts/gen-cli-reference.mjs\`.

**Every command accepts \`--json\`.** Agents should always pass it.

## Global options

\`\`\`
--profile <name>     use a specific profile
--data-dir <path>    override the data directory (beats ZMAIL_HOME)
--json               emit the stable JSON envelope
-q, --quiet          suppress progress on stderr
--verbose            more diagnostics
--no-color           disable coloured output
\`\`\`
`;

let missing = 0;
for (const g of GROUPS) {
  const text = help(g.args);
  if (!text) {
    missing++;
    console.error(`⚠️  ${g.title} 没有产生 help 输出`);
    continue;
  }
  out += `\n## \`${g.title}\`\n\n\`\`\`\n${text}\n\`\`\`\n`;
}

const target = "skills/zoho-mail/references/cli-reference.md";
writeFileSync(target, out);
console.error(`已写入 ${target}（${out.split("\n").length} 行，${missing} 个命令无输出）`);
process.exit(missing > 0 ? 1 : 0);
