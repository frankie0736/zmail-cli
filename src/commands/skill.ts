/**
 * zmail skill path / print —— 让 Agent 能找到并读取 SKILL.md。
 * zmail completion —— shell 补全。
 *
 * 第一版**不自动写入** Codex 或 Claude Code 的全局 skill 目录（§18）：
 * 那些目录的位置随版本变化，猜错会把文件写到用户没预期的地方。
 * 用户或 Agent 自己复制过去。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../core/context.js";
import { ErrorCode, ZmailError } from "../core/errors.js";

/** 定位随包分发的 skills 目录。开发布局与安装布局都要能找到。 */
export function findSkillsDir(fromUrl = import.meta.url): string {
  const here = dirname(fileURLToPath(fromUrl));
  for (const candidate of [
    join(here, "..", "..", "skills"), // src/commands/skill.ts → repo/skills
    join(here, "..", "skills"), // dist/cli.js → package/skills
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ZmailError(ErrorCode.NOT_FOUND, "找不到 skills 目录", {
    hint: "安装可能不完整，尝试重新安装 zmail-cli",
  });
}

export async function runSkillPath(ctx: Context): Promise<void> {
  const root = findSkillsDir();
  const skillDir = join(root, "zoho-mail");
  const refDir = join(skillDir, "references");
  ctx.out.emit(
    {
      skillDir,
      skillFile: join(skillDir, "SKILL.md"),
      references: existsSync(refDir) ? readdirSync(refDir).map((f) => join(refDir, f)) : [],
    },
    {},
    (d) =>
      [
        d.skillDir,
        "",
        "把整个目录复制到你的 Agent 的 skills 位置，例如：",
        `  cp -r ${d.skillDir} ~/.claude/skills/`,
        `  cp -r ${d.skillDir} .claude/skills/    # 或项目内`,
      ].join("\n"),
  );
}

export async function runSkillPrint(ctx: Context): Promise<void> {
  const file = join(findSkillsDir(), "zoho-mail", "SKILL.md");
  if (!existsSync(file)) {
    throw new ZmailError(ErrorCode.NOT_FOUND, `找不到 SKILL.md: ${file}`);
  }
  const content = readFileSync(file, "utf8");
  ctx.out.emit({ path: file, content }, {}, (d) => d.content);
}

// ---------------------------------------------------------------- completion

const BASH = `# zmail completion for bash
_zmail_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="init status doctor version config sync search message thread folder attachment data export auth skill completion"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi
  case "$prev" in
    auth)       COMPREPLY=( $(compgen -W "setup login status refresh revoke remove" -- "$cur") ) ;;
    config)     COMPREPLY=( $(compgen -W "path show" -- "$cur") ) ;;
    data)       COMPREPLY=( $(compgen -W "stats verify backup prune reset purge rebuild-index" -- "$cur") ) ;;
    attachment) COMPREPLY=( $(compgen -W "list download path prune" -- "$cur") ) ;;
    message|thread) COMPREPLY=( $(compgen -W "get" -- "$cur") ) ;;
    folder)     COMPREPLY=( $(compgen -W "list" -- "$cur") ) ;;
    skill)      COMPREPLY=( $(compgen -W "path print" -- "$cur") ) ;;
    *)          COMPREPLY=( $(compgen -W "--json --profile --data-dir --quiet --verbose --help" -- "$cur") ) ;;
  esac
}
complete -F _zmail_completions zmail
`;

const ZSH = `#compdef zmail
# zmail completion for zsh
_zmail() {
  local -a commands
  commands=(
    'init:create ~/.zmail/ and initialise the database'
    'status:show current status'
    'doctor:diagnose the installation'
    'sync:sync mail from Zoho'
    'search:full-text search the local mirror'
    'message:read a single message'
    'thread:read a thread'
    'folder:list folders'
    'attachment:manage attachments'
    'export:export mail to standard formats'
    'data:local data maintenance'
    'auth:manage Zoho authorization'
    'config:inspect configuration'
    'skill:print the agent skill location'
    'completion:emit shell completion'
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "\${words[2]}" in
    auth)       _values 'subcommand' setup login status refresh revoke remove ;;
    config)     _values 'subcommand' path show ;;
    data)       _values 'subcommand' stats verify backup prune reset purge rebuild-index ;;
    attachment) _values 'subcommand' list download path prune ;;
    message|thread) _values 'subcommand' get ;;
    folder)     _values 'subcommand' list ;;
    skill)      _values 'subcommand' path print ;;
    *)          _values 'option' --json --profile --data-dir --quiet --verbose --help ;;
  esac
}
_zmail "$@"
`;

const FISH = `# zmail completion for fish
complete -c zmail -f
complete -c zmail -n __fish_use_subcommand -a init -d 'create ~/.zmail/ and initialise the database'
complete -c zmail -n __fish_use_subcommand -a status -d 'show current status'
complete -c zmail -n __fish_use_subcommand -a doctor -d 'diagnose the installation'
complete -c zmail -n __fish_use_subcommand -a sync -d 'sync mail from Zoho'
complete -c zmail -n __fish_use_subcommand -a search -d 'full-text search the local mirror'
complete -c zmail -n __fish_use_subcommand -a message -d 'read a single message'
complete -c zmail -n __fish_use_subcommand -a thread -d 'read a thread'
complete -c zmail -n __fish_use_subcommand -a folder -d 'list folders'
complete -c zmail -n __fish_use_subcommand -a attachment -d 'manage attachments'
complete -c zmail -n __fish_use_subcommand -a export -d 'export mail'
complete -c zmail -n __fish_use_subcommand -a data -d 'local data maintenance'
complete -c zmail -n __fish_use_subcommand -a auth -d 'manage Zoho authorization'
complete -c zmail -n __fish_use_subcommand -a config -d 'inspect configuration'
complete -c zmail -n __fish_use_subcommand -a skill -d 'agent skill location'
complete -c zmail -l json -d 'emit the stable JSON envelope'
complete -c zmail -l profile -r -d 'use a specific profile'
complete -c zmail -l data-dir -r -d 'override the data directory'
complete -c zmail -s q -l quiet -d 'suppress progress output'
`;

export async function runCompletion(ctx: Context, shell: string): Promise<void> {
  const scripts: Record<string, string> = { bash: BASH, zsh: ZSH, fish: FISH };
  const script = scripts[shell];
  if (!script) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, `不支持的 shell: ${shell}`, {
      details: { supported: Object.keys(scripts) },
    });
  }
  // 补全脚本必须走 stdout —— 用户会 eval 它
  ctx.out.emit({ shell, script }, {}, (d) => d.script);
}
