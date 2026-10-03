/**
 * WCF-D10：**把 potbot 写出器的产物喂给外部真实 Word 取证**（E1/E2/E3/E3b 实验的驱动）。
 *
 * ## 这个文件是**驱动**，不是判据
 *
 * 它确实 import 了生产链路（`importDocx` / `importDocxDetailed` / `exportDocx` /
 * `applyEditPlan`）——因为要把**真实生产链路**的产物交给外部 Word。但它**不用生产实现当预期值**：
 * 每一份产物都再用**独立**的 Python 读回器（`scripts/demo/verify-docx.py`）复核，该读回器
 * 不 import 生产实现。
 *
 * ## 为什么要有它（把"输入成色"从"写出器行不行"里分离出来）
 *
 * | 实验 | 输入 | 编辑 | 回答什么 |
 * |---|---|---|---|
 * | **E1** | `corpus-c`（**真实 Microsoft Word 16 自产**） | **无（原样导出）** | 写出器 + 容器本身行不行 |
 * | **E2** | `corpus-c` | G1 那组编辑 | 产品真正要走的那条链行不行 |
 * | **E3** | `corpus-a`（合成语料，**当前**） | 无 | 合成语料是不是变量 |
 * | **E3b** | `corpus-a` **修复前字节**（由 `restore-prefix-corpus-a.py` 逐字节还原） | 无 | 把"那一行 Override"单独当变量 |
 *
 * Word 那一步不在这里（`word-open-inspect.py`，需要本机 Word）；产物落盘后由脚本驱动。
 *
 * ## E2 的一处**有意适配**（必须记下来）
 *
 * G1 那组编辑原本打在 `corpus-a` 的文本上（`分散对齐固定行距段落。` / `斜体下划线补充。`），
 * 而 `corpus-c` 里**没有这两段**。E2 把同样六个操作打到 `corpus-c` 的对应段落
 * `第一段正文，首行缩进两个字符。` 上——**语义相同，作用对象按语料可用文本换过**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportDocx, importDocx, importDocxDetailed } from '../../src/documents/docx/index.js';
import { applyEditPlan } from '../../src/documents/edit/plan.js';
import type { EditPlan } from '../../src/documents/edit/plan.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');

/** 产物落盘目录（可用环境变量覆盖；默认进 gitignore 的证据目录）。 */
const OUT_DIR = process.env['WCF_D10_EXPORT_DIR']
  ?? join(REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'D10',
          'word-export');

/** `corpus-a` 的目标段落（G1 验收用例用的那一段）。 */
const BODY_PARAGRAPH_A = '分散对齐固定行距段落。';
const SIZE_RUN_A = '斜体下划线补充。';
/** `corpus-c` 的对应段落（真实 Word 文件里可用的那段）。 */
const BODY_PARAGRAPH_C = '第一段正文，首行缩进两个字符。';

/**
 * G1 那组编辑的**语义**：14pt / 加粗 / 居中 / 1.5 倍行距 / 段后 6pt / 首行缩进 2 字。
 *
 * @param body 承接段落级操作与加粗的段落
 * @param sizeRun 承接 14pt 的那一小段文本
 */
function g1Plan(body: string, sizeRun: string): EditPlan {
  return {
    steps: [
      {
        range: `指定文本:${sizeRun}`,
        operation: {
          domain: 'character',
          operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 14 } },
        },
      },
      {
        range: `指定文本:${body}`,
        operation: {
          domain: 'character',
          operation: { kind: 'setToggle', property: 'bold', value: true },
        },
      },
      {
        range: `指定文本:${body}`,
        operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'center' } },
      },
      {
        range: `指定文本:${body}`,
        operation: {
          domain: 'paragraph',
          operation: { kind: 'setLineSpacing', spacing: { kind: 'oneAndHalf' } },
        },
      },
      {
        range: `指定文本:${body}`,
        operation: {
          domain: 'paragraph',
          operation: { kind: 'setSpacingAfter', spacing: { kind: 'pt', value: 6 } },
        },
      },
      {
        range: `指定文本:${body}`,
        operation: {
          domain: 'paragraph',
          operation: { kind: 'setFirstLineIndent', amount: { unit: 'chars', value: 2 } },
        },
      },
    ],
  };
}

function load(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** 原样导出（不做任何编辑）——E1 / E3 用。 */
function plainExport(input: Uint8Array): Uint8Array {
  return exportDocx(importDocx(input));
}

/** 原样导出，且**如实保留**内容类型不相容的诊断 —— E3b 用。 */
function plainExportTolerant(input: Uint8Array): {
  readonly product: Uint8Array;
  readonly diagnostics: readonly unknown[];
} {
  const { model, content_type_diagnostics } = importDocxDetailed(input, {
    allowInconsistentContentTypes: true,
  });
  return { product: exportDocx(model), diagnostics: content_type_diagnostics };
}

/** 导入 → 施加 G1 那组编辑 → 导出——E2 用。 */
function editedExport(input: Uint8Array, plan: EditPlan): Uint8Array {
  const model = importDocx(input);
  const applied = applyEditPlan(model, plan);
  if (!applied.ok) {
    throw new Error(`G1 计划被拒绝：${applied.code} / ${applied.message}`);
  }
  return exportDocx(applied.value.model);
}

/** 产物必须能被**独立** Python 读回器读回（不拿生产实现当判据）。 */
function assertIndependentlyReadable(path: string): void {
  const python = process.env['DEMO_PYTHON']
    ?? 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
  const verifier = join(REPO_ROOT, 'scripts', 'demo', 'verify-docx.py');
  expect(existsSync(verifier), `缺独立读回器：${verifier}`).toBe(true);
  const stdout = execFileSync(python, [verifier, path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(stdout) as { ok: boolean; error: unknown };
  expect(parsed.ok, `${path} 独立读回未通过：${JSON.stringify(parsed.error)}`).toBe(true);
}

function emit(name: string, bytes: Uint8Array): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, name);
  writeFileSync(out, bytes);
  assertIndependentlyReadable(out);
  return out;
}

function pythonExecutablePath(): string {
  return process.env['DEMO_PYTHON']
    ?? 'C:/Users/<user>/AppData/Local/Programs/Python/Python313/python.exe';
}

/**
 * 就地还原 `corpus-a` 的**修复前字节**（E3b 的对照）。
 *
 * **由本测试自己产出，不依赖任何预先存在的脚手架**——否则干净检出（没有 `.dev-evidence`）
 * 时 E3b 会因为"找不到对照文件"而失败，那就成了"测试要求人手准备夹具"。
 * 还原脚本自带摘要自校验：还原结果与登记的修复前摘要 `b770029d…` 不一致就非零退出，
 * 这里跟着失败——**宁可失败，也不要一个"差不多的对照"**。
 */
function provisionPrefixCorpusA(): string {
  const out = join(OUT_DIR, 'prefix-corpus-a.docx');
  mkdirSync(OUT_DIR, { recursive: true });
  const script = join(FIXTURES, 'restore-prefix-corpus-a.py');
  expect(existsSync(script), `缺还原脚本：${script}`).toBe(true);
  execFileSync(pythonExecutablePath(), [script, out], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  return out;
}

describe('把写出器产物交给外部 Word 取证（E1/E2/E3/E3b 驱动）', () => {
  it('E1：corpus-c（真实 Word 文件）→ 原样导出', () => {
    emit('e1-corpusC-plain.docx', plainExport(load(join(FIXTURES, 'corpus-c-word16-created.docx'))));
  });

  it('E2：corpus-c → G1 那组编辑（按语料可用文本适配作用对象）→ 导出', () => {
    const product = editedExport(
      load(join(FIXTURES, 'corpus-c-word16-created.docx')),
      g1Plan(BODY_PARAGRAPH_C, BODY_PARAGRAPH_C),
    );
    emit('e2-corpusC-g1edit.docx', product);
  });

  it('E3：corpus-a（合成语料，当前）→ 原样导出', () => {
    emit('e3-corpusA-plain.docx',
         plainExport(load(join(FIXTURES, 'corpus-a-independent-deflate.docx'))));
  });

  it('E3b：corpus-a **修复前字节** → 原样导出（对照文件就地还原，并把诊断当证据留下）', () => {
    const prefix = provisionPrefixCorpusA();
    const { product, diagnostics } = plainExportTolerant(load(prefix));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'e3b-prefix-content-type-diagnostics.json'),
      JSON.stringify(diagnostics, null, 2),
      'utf8',
    );
    // 修复前的语料**应当**带诊断（这正是它与当前 corpus-a 的唯一差别）。
    expect(diagnostics.length, '修复前语料应当报出内容类型不相容').toBeGreaterThan(0);
    emit('e3b-corpusA-prefix-plain.docx', product);
  });
});
