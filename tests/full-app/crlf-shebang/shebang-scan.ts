/**
 * FA-CRLF-SHEBANG-SCAN —— 全仓 shebang 文件行尾普查器（**只读**）
 *
 * 目的：把"哪些 tracked 文件首行有 shebang、工作区行尾是什么、有没有 .gitattributes 保护"
 * 变成可机读、可回归的结论，而不是靠人眼。
 *
 * 判定（严格照任务口径）：
 *   **RED** = 首行有 shebang && 工作区首行行尾为 CRLF && 无 `eol=lf` 属性保护
 * 其余三种为信息档（ADVISORY / OK），不报红但会列出来，避免"只红不管"的假安全感。
 *
 * 反面：`VITE_TRANSFORMABLE_EXTENSIONS` 里的扩展名才是**真门禁阻塞**面
 * （vite / vite-node 会做 SSR 变换，CRLF shebang 必炸）；其它扩展名
 * （.sh / .py / .ps1 …）的 CRLF shebang 是 **Unix 侧**故障（`bash a.sh` →
 * `\r: command not found`；`#!/usr/bin/env python3\r` → `env: 'python3\r': 没有那个文件`）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 会被 vite / vite-node 做 SSR 变换的扩展名 —— 这类文件 CRLF+shebang 直接阻塞门禁。 */
export const VITE_TRANSFORMABLE_EXTENSIONS: readonly string[] = [
  '.mjs',
  '.mts',
  '.js',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
];

export type ShebangVerdict =
  | 'NOT_APPLICABLE_NO_SHEBANG' // 首行无 shebang：本题不适用（行尾随便）
  | 'OK_LF_PROTECTED' // LF + eol=lf：最稳
  | 'OK_LF_UNPROTECTED' // LF 但无属性：当前无害，但 core.autocrlf=true 下次检出会变 CRLF（潜在）
  | 'ADVISORY_CRLF_PROTECTED' // CRLF 但属性保证下次检出为 LF：本次无害，工作区是陈旧的
  | 'RED_CRLF_UNPROTECTED'; // ★ 报红

export interface ShebangFileReport {
  /** 仓库相对路径（git 风格，正斜杠） */
  path: string;
  /** 小写扩展名（含点）；无扩展名则为 '' */
  ext: string;
  /** 首行是否为 `#!` —— 判定的前置条件（不满足 ⇒ NOT_APPLICABLE） */
  hasShebang: boolean;
  /** 工作区首行行尾 */
  worktreeEol: 'LF' | 'CRLF';
  /** 工作区文件里是否**处处**都是 LF（无任何 CRLF 字节） */
  purelyLf: boolean;
  /** `git check-attr eol` 结果（'lf' / 'crlf' / 'unspecified' / …） */
  attrEol: string;
  /** `git check-attr text` 结果 */
  attrText: string;
  /** 保护成立 = attrEol 恰为 'lf'（`eol=crlf` 不算保护，它反而强制 CRLF） */
  protectedByAttributes: boolean;
  /** 是否属于 vite/vite-node 会变换的扩展名 */
  viteTransformable: boolean;
  verdict: ShebangVerdict;
}

export interface ShebangScanResult {
  repoRoot: string;
  trackedCount: number;
  shebangCount: number;
  reports: ShebangFileReport[];
  /** ★ 报红集合 */
  red: ShebangFileReport[];
  /** 报红且属于 vite 可变换扩展名 = **真门禁阻塞** */
  blockingRed: ShebangFileReport[];
  /** 报红但不属于 vite 可变换扩展名 = Unix 侧故障 */
  unixRed: ShebangFileReport[];
  advisory: ShebangFileReport[];
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** 仓库根（`git rev-parse --show-toplevel`），posix 化 */
export function resolveRepoRoot(startDir: string = process.cwd()): string {
  return git(startDir, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/');
}

/** 所有 tracked 文件（`git ls-files -z`） */
export function listTrackedFiles(repoRoot: string): string[] {
  return git(repoRoot, ['ls-files', '-z']).split('\0').filter((s) => s.length > 0);
}

function containsCrlf(buf: Buffer): boolean {
  for (let i = 1; i < buf.length; i += 1) {
    if (buf[i] === 0x0a && buf[i - 1] === 0x0d) return true;
  }
  return false;
}

/**
 * 读文件：判断是否有 shebang、首行行尾、是否纯粹 LF。
 *
 * 分两段读：先读文件头（便宜的 shebang 筛查，全仓 2.6k 文件都要过），
 * 只有**确有 shebang** 时才整文件读一遍来定 `purelyLf`（本仓只有 33 个，代价可忽略）。
 * 只读文件头就断言"纯粹 LF"是假结论，所以截断时一律不敢下结论。
 */
export function inspectLineEnding(
  absPath: string,
  readBytes = 8192,
): { hasShebang: boolean; worktreeEol: 'LF' | 'CRLF'; purelyLf: boolean } {
  const fd = fs.openSync(absPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const headLen = Math.min(size, readBytes);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) fs.readSync(fd, head, 0, headLen, 0);
    const hasShebang = head.length >= 2 && head[0] === 0x23 && head[1] === 0x21;
    const nl = head.indexOf(0x0a);
    const worktreeEol: 'LF' | 'CRLF' = nl > 0 && head[nl - 1] === 0x0d ? 'CRLF' : 'LF';
    if (!hasShebang) {
      return { hasShebang, worktreeEol, purelyLf: !containsCrlf(head) && headLen === size };
    }
    const whole = Buffer.alloc(size);
    if (size > 0) fs.readSync(fd, whole, 0, size, 0);
    return { hasShebang, worktreeEol, purelyLf: !containsCrlf(whole) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * **独立于字节读取**的候选集交叉核对：借 `git grep` 自己找"含以 `#!` 开头的行"的
 * tracked 文件，再由本模块按"首行"过滤。用于在测试里对拍"有没有漏收/错收"。
 */
export function gitGrepShebangFirstLine(repoRoot: string): string[] {
  let rawOut = '';
  try {
    rawOut = git(repoRoot, ['grep', '-I', '-l', '-z', '--full-name', '-e', '^#!']);
  } catch {
    return []; // git grep 无匹配时退出码 1
  }
  const raw = rawOut.split('\0');
  const out: string[] = [];
  for (const rel of raw) {
    if (rel === '') continue;
    try {
      if (inspectLineEnding(path.join(repoRoot, rel)).hasShebang) out.push(rel);
    } catch {
      /* 已在 scanRepo 里报告 */
    }
  }
  return out;
}

/**
 * 批量 `git check-attr -z [--source=<rev>] eol text -- <paths…>`。
 *
 * 传 `source` 可指定**属性源**（`--source=HEAD` 就是"按 HEAD 里的 .gitattributes 判"），
 * 于是"加规则之前 / 之后"的差别可以被**机读复算**，而不是靠叙述。
 */
export function checkAttributes(
  repoRoot: string,
  relPaths: readonly string[],
  source?: string,
): Map<string, { eol: string; text: string }> {
  const out = new Map<string, { eol: string; text: string }>();
  if (relPaths.length === 0) return out;
  const srcArgs = source === undefined ? [] : [`--source=${source}`];
  const raw = git(repoRoot, ['check-attr', ...srcArgs, '-z', 'eol', 'text', '--', ...relPaths]);
  const parts = raw.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const p = parts[i];
    const attr = parts[i + 1];
    const value = parts[i + 2];
    if (p === undefined || attr === undefined || value === undefined || p === '') continue;
    const cur = out.get(p) ?? { eol: 'unspecified', text: 'unspecified' };
    if (attr === 'eol') cur.eol = value;
    if (attr === 'text') cur.text = value;
    out.set(p, cur);
  }
  return out;
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** 单文件判定（供**反向对照**直接调用：可传任意临时文件） */
export function evaluateShebangFile(
  repoRoot: string,
  relPath: string,
  absPath: string,
  attr: { eol: string; text: string } | undefined,
): ShebangFileReport {
  const inspected = inspectLineEnding(absPath);
  const attrEol = attr?.eol ?? 'unspecified';
  const attrText = attr?.text ?? 'unspecified';
  const protectedByAttributes = attrEol === 'lf';
  const ext = extOf(relPath);
  const viteTransformable = VITE_TRANSFORMABLE_EXTENSIONS.includes(ext);
  let verdict: ShebangVerdict;
  if (!inspected.hasShebang) {
    // 判定前提不成立：本题只关心"首行有 shebang"的文件
    // 注意顺序 —— 先看有无 shebang，再看行尾；否则会把普通 CRLF 文件误报成红
    verdict = 'NOT_APPLICABLE_NO_SHEBANG';
  } else if (inspected.worktreeEol === 'CRLF' && !protectedByAttributes) {
    verdict = 'RED_CRLF_UNPROTECTED';
  } else if (inspected.worktreeEol === 'CRLF') {
    verdict = 'ADVISORY_CRLF_PROTECTED';
  } else if (protectedByAttributes) {
    verdict = 'OK_LF_PROTECTED';
  } else {
    verdict = 'OK_LF_UNPROTECTED';
  }
  return {
    path: relPath,
    ext,
    hasShebang: inspected.hasShebang,
    worktreeEol: inspected.worktreeEol,
    purelyLf: inspected.purelyLf,
    attrEol,
    attrText,
    protectedByAttributes,
    viteTransformable,
    verdict,
  };
}

/** 全仓普查：所有 tracked 且首行有 shebang 的文件 */
export function scanRepo(startDir: string = process.cwd()): ShebangScanResult {
  const repoRoot = resolveRepoRoot(startDir);
  const tracked = listTrackedFiles(repoRoot);
  const candidates: string[] = [];
  for (const rel of tracked) {
    const abs = path.join(repoRoot, rel);
    try {
      if (inspectLineEnding(abs).hasShebang) candidates.push(rel);
    } catch {
      // 读不到（子模块 / 符号链接悬空 / 已删除）⇒ 不纳入普查，也不静默报绿：计入 stderr 由测试可见
      process.stderr.write(`[shebang-scan] 跳过不可读文件: ${rel}\n`);
    }
  }
  const attrs = checkAttributes(repoRoot, candidates);
  const reports = candidates.map((rel) =>
    evaluateShebangFile(repoRoot, rel, path.join(repoRoot, rel), attrs.get(rel)),
  );
  const red = reports.filter((r) => r.verdict === 'RED_CRLF_UNPROTECTED');
  const advisory = reports.filter((r) => r.verdict === 'ADVISORY_CRLF_PROTECTED');
  return {
    repoRoot,
    trackedCount: tracked.length,
    shebangCount: candidates.length,
    reports,
    red,
    blockingRed: red.filter((r) => r.viteTransformable),
    unixRed: red.filter((r) => !r.viteTransformable),
    advisory,
  };
}

/** 打印一行机读摘要（测试失败时能直接看到清单） */
export function formatReport(r: ShebangFileReport): string {
  return [
    r.verdict.padEnd(24),
    r.ext.padEnd(6),
    r.worktreeEol.padEnd(5),
    `eol=${r.attrEol}`.padEnd(16),
    r.viteTransformable ? 'vite' : 'unix',
    r.path,
  ].join(' ');
}
