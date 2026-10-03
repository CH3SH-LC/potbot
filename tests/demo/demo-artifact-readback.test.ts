/**
 * S6 验收用例 ④：**真实产物的独立读回 + 内核链路证据**（验收表「DOCX」「内核」两行）。
 *
 * 判据（验收表原文）："新文件字节、摘要、独立 ZIP/XML 读回；正文等于发布草稿"。
 * 不足以通过的："文件存在、扩展名正确或服务返回 200"。
 *
 * ## 一次被自己抓到的假阳性（保留在注释里，避免以后重犯）
 *
 * 第一版只扫描 `.runtime/mobile-word-demo/**` 下的**任意** `.docx`。结果它把
 * S5 的**独立样例**（`apps/demo/documents/generate-sample.ts` 产出的
 * `<runDir>/MWD-20261002-A-invitation/…docx`）当成了 Demo 链路产物而"通过"——
 * 而那份文件的自述头注释明写"**不是** Demo 运行链路的证据"。
 *
 * 修正后的口径（**只认链路产物**）：
 *   1. 必须在宿主的应用索引 `<runDir>/app-index.json` 里有对应的 `ready` 任务；
 *   2. 产物必须落在宿主声明的产物根 `<runDir>/artifacts/**`（S5 样例不在其中）；
 *   3. 摘要 / 长度 / 正文必须与索引里登记的 `artifact` 与 `draft` 对齐；
 *   4. 任务必须带内核轮次 id 与内核发布的产物 id（证明真的走了调度链）。
 * 不在 `artifacts/` 下的 DOCX 会被**显式列出**并说明"不计入"。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, listFiles, readbackDocx, repoRelative } from './support.js';

const RUN_ID = process.env['DEMO_RUN_ID'] ?? 'MWD-20261002-A';
const RUNTIME_ROOT = join(REPO_ROOT, '.runtime', 'mobile-word-demo');
const RUN_DIR = join(RUNTIME_ROOT, RUN_ID);
const ARTIFACT_ROOT = join(RUN_DIR, 'artifacts');
const INDEX_PATH = join(RUN_DIR, 'app-index.json');

interface IndexedArtifact {
  readonly artifactId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface IndexedTask {
  readonly taskId: string;
  readonly requestId: string;
  readonly instruction: string;
  readonly status: string;
  readonly draft: { readonly title: string; readonly paragraphs: readonly { readonly text: string }[] } | null;
  readonly artifact: IndexedArtifact | null;
  readonly kernelRuns: readonly string[];
  readonly publishedArtifactId: string | null;
}

function loadIndex(): { tasks: readonly IndexedTask[] } | null {
  if (!existsSync(INDEX_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as { tasks?: readonly IndexedTask[] };
    return { tasks: parsed.tasks ?? [] };
  } catch {
    return null;
  }
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const index = loadIndex();
const readyTasks = (index?.tasks ?? []).filter((task) => task.artifact !== null);

/** 产物根下的 DOCX（= 链路产物候选）。 */
const artifactDocx = listFiles(ARTIFACT_ROOT).filter((path) => path.toLowerCase().endsWith('.docx'));
/** 运行目录里**不在**产物根下的 DOCX：应当被排除（例如 S5 独立样例）。 */
const nonChainDocx = listFiles(RUN_DIR)
  .filter((path) => path.toLowerCase().endsWith('.docx'))
  .filter((path) => !path.startsWith(ARTIFACT_ROOT));

function findArtifactFile(artifact: IndexedArtifact): string | null {
  const needle = artifact.filename.toLowerCase();
  const hits = listFiles(ARTIFACT_ROOT).filter(
    (path) => path.toLowerCase().endsWith(`/${needle}`) || path.toLowerCase().endsWith(`\\${needle}`),
  );
  if (hits.length === 0) return null;
  // 目录名应包含 artifactId（宿主声明的命名约定）；有多个同名文件时优先该项。
  return hits.find((path) => path.includes(artifact.artifactId)) ?? hits[0] ?? null;
}

describe('Demo 链路产物（应用索引驱动，独立读回）', () => {
  it('[前置] 宿主应用索引存在，且至少有一条已发布的 ready 任务', () => {
    expect(
      existsSync(INDEX_PATH),
      `[未满足] 尚无 ${repoRelative(INDEX_PATH)}：宿主应用索引尚未落盘（服务未跑过或未持久化），本组判据无从成立`,
    ).toBe(true);
    expect(
      readyTasks.length,
      `[未满足] ${repoRelative(INDEX_PATH)} 中没有任何带 artifact 的 ready 任务：链路尚未跑通到发布`,
    ).toBeGreaterThan(0);
  });

  it('链路产物落在宿主声明的产物根 artifacts/**（S5 独立样例不计入）', () => {
    expect(readyTasks.length, '[未满足] 没有可核对的链路产物').toBeGreaterThan(0);
    const excluded = nonChainDocx.map((path) => repoRelative(path));
    expect(
      artifactDocx.length,
      `[未通过] 产物根 ${repoRelative(ARTIFACT_ROOT)} 下没有 DOCX：索引里登记了产物，盘上却没有。` +
        (excluded.length > 0
          ? `\n（另发现 ${excluded.length} 份**不在产物根**的 DOCX，按口径不计入链路证据：${excluded.join('、')}）`
          : ''),
    ).toBeGreaterThan(0);
  });

  it('索引登记的摘要/长度与盘上字节一致，且能被独立读回器解析', () => {
    const failures: string[] = [];
    for (const task of readyTasks) {
      const artifact = task.artifact;
      if (artifact === null) continue;
      const file = findArtifactFile(artifact);
      if (file === null) {
        failures.push(`${task.taskId}: 索引登记的 ${artifact.filename} 在产物根下找不到`);
        continue;
      }
      const actualSha = sha256OfFile(file);
      if (actualSha !== artifact.sha256) {
        failures.push(`${task.taskId}: 盘上 sha256 ${actualSha} ≠ 索引登记 ${artifact.sha256}`);
      }
      const bytes = readFileSync(file).byteLength;
      if (bytes !== artifact.byteLength) {
        failures.push(`${task.taskId}: 盘上 ${bytes} 字节 ≠ 索引登记 ${artifact.byteLength}`);
      }
      const readback = readbackDocx(file);
      if (readback.exitCode !== 0 || readback.parsed?.ok !== true) {
        failures.push(`${task.taskId}: 独立读回失败 code=${readback.parsed?.error?.code ?? 'n/a'}`);
        continue;
      }
      const document = readback.parsed.document;
      if (!document || document.non_empty_count < 2) {
        failures.push(`${task.taskId}: 非空段落 ${document?.non_empty_count ?? 0} < 2`);
      }
    }
    expect(failures, `[未通过] 产物核对失败：\n${failures.join('\n')}`).toEqual([]);
  });

  it('新文档仅标题正文；历史来源版按其原始呈现合同逐字核对', () => {
    // 判据（2026-10-02 主协调者裁定）：
    //  - **硬判据**：文档前 (1 + paragraphs.length) 段逐字等于 [title, ...paragraphs]；
    //  - 「已确认事实 / 资料引用」两节**允许存在**，但必须逐字核对：来源节要逐字回写用户原文，
    //    声明节要写明"模型生成、非事实核实"，且**不得夹带未经用户输入的数值事实**。
    const FACTS_HEADING = '已确认事实';
    const REFERENCES_HEADING = '资料引用';
    const failures: string[] = [];
    for (const task of readyTasks) {
      if (task.artifact === null || task.draft === null) continue;
      const file = findArtifactFile(task.artifact);
      if (file === null) continue;
      const readback = readbackDocx(file);
      const paragraphs = (readback.parsed?.document?.paragraphs ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
      const expected = [task.draft.title.trim(), ...task.draft.paragraphs.map((p) => p.text.trim())].filter(
        (p) => p.length > 0,
      );
      const prefix = paragraphs.slice(0, expected.length);
      const prefixEqual = prefix.length === expected.length && expected.every((line, i) => line === prefix[i]);
      if (!prefixEqual) {
        failures.push(
          `${task.taskId}: 草稿 ${expected.length} 段 vs 文档前 ${prefix.length} 段\n` +
            `  草稿：${expected.slice(0, 2).join(' | ')}\n  文档：${prefix.slice(0, 2).join(' | ')}`,
        );
        continue;
      }

      const extras = paragraphs.slice(expected.length);
      const presentation = readback.parsed?.document?.presentation;
      if (presentation === 'title-body-v1') {
        if (extras.length !== 0) failures.push(`${task.taskId}: 正文版出现 ${extras.length} 个系统附加段落`);
        continue;
      }
      if (presentation != null) {
        failures.push(`${task.taskId}: 未支持的呈现版本 ${presentation}`);
        continue;
      }
      // No presentation marker: preserve verification of immutable historical files.
      let echo: string | null = null;
      let declaration = false;
      const unexplained: string[] = [];
      for (const line of extras) {
        if (line === FACTS_HEADING || line === REFERENCES_HEADING) continue;
        if (line.startsWith('source.user_request: ')) {
          echo = line.slice('source.user_request: '.length);
          continue;
        }
        if (line.includes('模型生成') && line.includes('不是既有事实的核实结果')) {
          declaration = true;
          continue;
        }
        unexplained.push(line);
      }
      if (unexplained.length > 0) {
        failures.push(`${task.taskId}: 额外段落无法解释：${unexplained.map((p) => p.slice(0, 30)).join(' ; ')}`);
      }
      if (echo !== task.instruction.trim()) {
        failures.push(
          `${task.taskId}: 来源节未逐字回写用户原文（得到 ${JSON.stringify(echo).slice(0, 60)}）`,
        );
      }
      if (!declaration) {
        failures.push(`${task.taskId}: 缺少"模型生成、非事实核实"声明节`);
      }
      const digits = extras
        .filter((line) => !line.startsWith('source.user_request: '))
        .join('\n')
        .match(/[0-9]+/g);
      if (digits && digits.length > 0) {
        failures.push(
          `${task.taskId}: 额外节出现未经用户输入的数值事实：${[...new Set(digits)].join('、')}`,
        );
      }
    }
    expect(failures, `[未通过] 正文/来源节与发布草稿不一致：\n${failures.join('\n')}`).toEqual([]);
  });

  it('输出实际读出的完整结构（供报告逐字引用，不是判据）', () => {
    const lines: string[] = [];
    for (const task of readyTasks) {
      if (task.artifact === null) continue;
      const file = findArtifactFile(task.artifact);
      if (file === null) continue;
      const readback = readbackDocx(file);
      const paragraphs = readback.parsed?.document?.paragraphs ?? [];
      lines.push(`${task.taskId} (${task.artifact.filename}) ${paragraphs.length} 段：`);
      paragraphs.forEach((p, i) => lines.push(`  ${i} ${p}`));
    }
    expect(lines.length, `[未满足] 没有可输出的结构`).toBeGreaterThan(0);
  });

  it('任务带内核轮次 id 与内核发布的产物 id（证明走了调度链，而非 HTTP 直接写盘）', () => {
    const failures: string[] = [];
    for (const task of readyTasks) {
      if (task.kernelRuns.length === 0) {
        failures.push(`${task.taskId}: kernelRuns 为空——没有内核轮次，无法证明经过调度链`);
      }
      if (!task.publishedArtifactId) {
        failures.push(`${task.taskId}: publishedArtifactId 为空——没有内核发布身份`);
      }
      if (task.requestId.trim().length === 0) {
        failures.push(`${task.taskId}: requestId 为空——无法把请求与产物对应`);
      }
      // 来源记录：索引里必须留下用户输入的**原文**（不得为空、不得被替换成固定样例）。
      if (task.instruction.trim().length === 0) {
        failures.push(`${task.taskId}: instruction 为空——缺少用户输入来源记录`);
      }
    }
    expect(failures, `[未通过] 内核链路证据不足：\n${failures.join('\n')}`).toEqual([]);
  });
});
