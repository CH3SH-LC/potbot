/**
 * WCF-D34：`edit-intent.js` 的判据。
 *
 * 核心一条：**本页镜像的内核白名单不能漂移**——凡是页面敢提交的操作，
 * 都必须被内核真实的 `compileEditIntent` 接受；凡是页面标成"暂不可用"的
 * （带值型属性的 setValue），内核也必须确实拒绝。两边用同一个函数对拍。
 */

import { describe, expect, it } from 'vitest';

import { SESSION_LIMITS } from '../.././../apps/demo/contracts.js';
import { compileEditIntent } from '../../../src/documents/session/intent.js';
import { CHINESE_FONT_SIZE_NAMES } from '../../../src/documents/units/font-size.js';
import { loadWebGlobal } from './harness.js';

interface Control {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly input: string;
  readonly property?: string;
  readonly supported?: boolean;
  readonly values?: readonly string[];
}

interface BuildResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly step?: { range: string; operation: Record<string, unknown> };
}

interface Staging {
  readonly limit: number;
  add(step: { range: string; operation: Record<string, unknown> }): { ok: boolean; index?: number; code?: string; message?: string };
  undo(): { range: string } | null;
  redo(): { range: string } | null;
  steps(): Array<{ range: string }>;
  size(): number;
  canUndo(): boolean;
  canRedo(): boolean;
  undoneCount(): number;
  clear(): Array<{ range: string }>;
  toIntent(): { steps: Array<{ range: string }> };
}

interface Verdict {
  readonly kind: string;
  readonly showsSuccess: boolean;
  readonly keepsStaged: boolean;
  readonly retryable: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly note?: string;
  readonly currentRevision?: number | null;
  readonly requestedRevision?: number | null;
  readonly reason?: string | null;
  readonly editRevision?: number | null;
  readonly reports?: readonly unknown[];
}

interface EditIntentModule {
  readonly MAX_STEPS_PER_INTENT: number;
  readonly CONTROLS: readonly Control[];
  readonly TOGGLE_PROPERTIES: readonly string[];
  readonly SUPPORTED_OPERATION_KINDS: readonly string[];
  readonly SET_VALUE_PROPERTIES: readonly string[];
  readonly FONT_SLOTS: readonly string[];
  readonly CHINESE_FONT_SIZE_NAMES: readonly string[];
  readonly UNWIRED_REASON: string;
  controlById(id: string): Control | null;
  buildStep(range: string | null, controlId: string, value: unknown): BuildResult;
  localRejection(operation: Record<string, unknown>): { code: string; message: string } | null;
  createStaging(options?: { limit?: number }): Staging;
  classifyEditResponse(httpStatus: number, data: unknown): Verdict;
  describeReports(reports: readonly unknown[]): string;
  toIntent(steps: readonly unknown[]): { steps: readonly unknown[] };
  newKey(prefix?: string): string;
}

const EditIntent = loadWebGlobal<EditIntentModule>('edit-intent.js', 'PotbotEditIntent', {
  crypto: (globalThis as { crypto?: unknown }).crypto,
});

/** 内核是否接受这一步（用真实的意图编译器）。 */
function kernelAccepts(step: { range: string; operation: Record<string, unknown> }): boolean {
  return compileEditIntent({ steps: [step] }).ok;
}

const TOGGLE_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ['bold', true], ['bold', false], ['italic', true], ['strike', true],
  ['doubleStrike', true], ['caps', true], ['smallCaps', false],
];

const VALUE_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ['clearDirectFormat', undefined],
  ['underlineNone', undefined],
  ['alignment', 'left'], ['alignment', 'center'], ['alignment', 'right'],
  ['alignment', 'justify'], ['alignment', 'distribute'],
  ['lineSpacing', 'single'], ['lineSpacing', 'oneAndHalf'], ['lineSpacing', 'double'],
  ['lineSpacing', { mode: 'multiple', value: 1.5 }],
  ['lineSpacing', { mode: 'exact', unit: 'pt', value: 12 }],
  ['lineSpacing', { mode: 'atLeast', unit: 'pt', value: 12 }],
  ['spacingBefore', { mode: 'pt', value: 6 }],
  ['spacingAfter', { mode: 'lines', value: 1 }],
  ['spacingBefore', { mode: 'auto' }],
  ['firstLineIndent', { mode: 'chars', value: 2 }],
  ['firstLineIndent', { mode: 'length', unit: 'cm', value: 1 }],
  ['hangingIndent', { mode: 'chars', value: 2 }],
  ['leftIndent', { mode: 'length', unit: 'pt', value: 6 }],
  ['rightIndent', { mode: 'chars', value: 1 }],
  ['clearParagraphFormat', undefined],
  /* --- 带值通道（FA-P 接线）：字体（中西文分设）与字号 ------------------- */
  ['fonts', { ascii: 'Times New Roman', eastAsia: '宋体' }],
  ['fonts', { eastAsia: '微软雅黑' }],
  ['size', { kind: 'pt', value: 12 }],
  ['size', { kind: 'pt', value: 10.5 }],
  ['size', { kind: 'chinese', name: '小四' }],
];

describe('edit-intent.js：镜像内核白名单（对拍）', () => {
  it('每个可提交控件产出的操作，内核确实接受', () => {
    const accepted: string[] = [];
    for (const [controlId, value] of [...TOGGLE_CASES, ...VALUE_CASES]) {
      const built = EditIntent.buildStep('第1段', controlId, value);
      expect(built.ok, `${controlId} 应当可以提交：${built.message ?? ''}`).toBe(true);
      if (!built.ok || built.step === undefined) throw new Error('不应通过');
      expect(
        kernelAccepts(built.step),
        `内核拒绝了页面敢提交的操作：${JSON.stringify(built.step.operation)}`,
      ).toBe(true);
      accepted.push(JSON.stringify(built.step.operation));
    }
    /* 断言覆盖到所有"可提交"控件，避免漏测某个控件却不自知。 */
    const submittable = EditIntent.CONTROLS.filter((control) => control.supported !== false && control.input !== 'unwired');
    const coveredControls = new Set([...TOGGLE_CASES, ...VALUE_CASES].map(([id]) => id));
    for (const control of submittable) {
      expect(coveredControls.has(control.id), `控件 ${control.id} 没有对拍用例`).toBe(true);
    }
    expect(accepted.length).toBe(TOGGLE_CASES.length + VALUE_CASES.length);
  });

  it('标成"暂不可用"的控件：页面不提交，且内核也确实没有这条通道', () => {
    const unwired = EditIntent.CONTROLS.filter((control) => control.input === 'unwired');
    /* FA-P 之后：字体 / 字号已接线（走 setValue），剩下的四个带值属性仍未开放。 */
    expect(unwired.map((control) => control.id).sort()).toEqual(
      ['color', 'highlight', 'underlineStyle', 'vertAlign'],
    );

    for (const control of unwired) {
      const built = EditIntent.buildStep('第1段', control.id, '任何值');
      expect(built.ok).toBe(false);
      expect(built.code).toBe('unsupported');
      expect(built.message ?? '').toContain('setValue');

      /* 页面"本该"用它设置的值 —— 内核必须同样判 unsupported（镜像没撒谎）。 */
      const wouldBe = { range: '第1段', operation: { kind: 'setValue', property: control.property, value: {} } };
      const verdict = compileEditIntent({ steps: [wouldBe] });
      expect(verdict.ok, `${control.id} 的 setValue 竟然被内核接受了？`).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('unsupported');
    }
  });

  it('缺范围 / 未知控件 / 非法取值一律本地拒绝，不提交', () => {
    expect(EditIntent.buildStep(null, 'bold', true).code).toBe('no_range');
    expect(EditIntent.buildStep('   ', 'bold', true).code).toBe('no_range');
    expect(EditIntent.buildStep('第1段', 'nope', true).code).toBe('unknown_control');
    const badAlignment = EditIntent.buildStep('第1段', 'alignment', 'middle');
    expect(badAlignment.ok).toBe(false);
    expect(badAlignment.code).toBe('invalid_value');
    const badIndent = EditIntent.buildStep('第1段', 'firstLineIndent', { mode: 'chars', value: 'x' });
    expect(badIndent.ok).toBe(false);
    const badSpacing = EditIntent.buildStep('第1段', 'spacingBefore', { mode: 'pt' });
    expect(badSpacing.ok).toBe(false);
  });

  it('步骤上限与共享合同一致（不是各写各的数字）', () => {
    expect(EditIntent.MAX_STEPS_PER_INTENT).toBe(SESSION_LIMITS.maxStepsPerIntent);
  });
});

describe('edit-intent.js：setValue（字体 / 字号）双向对拍', () => {
  it('镜像的内核常量与内核逐字一致（"不得自造表"的落地）', () => {
    expect(EditIntent.CHINESE_FONT_SIZE_NAMES).toEqual([...CHINESE_FONT_SIZE_NAMES]);
    expect(EditIntent.CHINESE_FONT_SIZE_NAMES).toHaveLength(16);
    expect(EditIntent.FONT_SLOTS).toEqual(['ascii', 'hAnsi', 'eastAsia', 'cs']);
    expect(EditIntent.SET_VALUE_PROPERTIES).toEqual(['fonts', 'size']);
    expect(EditIntent.SUPPORTED_OPERATION_KINDS).toContain('setValue');
  });

  /** 正反两面的取值矩阵：本地判定与内核判定必须逐条一致。 */
  const MATRIX: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['fonts: 只给西文', { kind: 'setValue', property: 'fonts', value: { ascii: 'Times New Roman' } }],
    ['fonts: 只给中文', { kind: 'setValue', property: 'fonts', value: { eastAsia: '宋体' } }],
    ['fonts: 三槽', { kind: 'setValue', property: 'fonts', value: { ascii: 'Arial', eastAsia: '微软雅黑', cs: 'Arial' } }],
    ['fonts: 空对象', { kind: 'setValue', property: 'fonts', value: {} }],
    ['fonts: 空串', { kind: 'setValue', property: 'fonts', value: { ascii: '' } }],
    ['fonts: 全空白', { kind: 'setValue', property: 'fonts', value: { ascii: '   ' } }],
    ['fonts: 全 null', { kind: 'setValue', property: 'fonts', value: { ascii: null, eastAsia: null } }],
    ['fonts: 值是字符串', { kind: 'setValue', property: 'fonts', value: '宋体' }],
    ['size: pt 12', { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 12 } }],
    ['size: pt 10.5', { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 10.5 } }],
    ['size: pt 12.3（不可表示）', { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 12.3 } }],
    ['size: pt 0', { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 0 } }],
    ['size: pt 负数', { kind: 'setValue', property: 'size', value: { kind: 'pt', value: -2 } }],
    ['size: pt 是字符串', { kind: 'setValue', property: 'size', value: { kind: 'pt', value: '12' } }],
    ['size: 中文字号 小四', { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '小四' } }],
    ['size: 中文字号 初号', { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '初号' } }],
    ['size: 不存在的字号名', { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '特大号' } }],
    ['size: 未知 kind', { kind: 'setValue', property: 'size', value: { kind: 'em', value: 1 } }],
    /* 未开放的带值属性：两边都必须拒。 */
    ['未开放: underline', { kind: 'setValue', property: 'underline', value: { kind: 'single' } }],
    ['未开放: color', { kind: 'setValue', property: 'color', value: { rgb: 'FF0000' } }],
    ['未开放: highlight', { kind: 'setValue', property: 'highlight', value: { name: 'yellow' } }],
    ['未开放: spacing', { kind: 'setValue', property: 'spacing', value: { twips: 20 } }],
  ];

  it('每一条取值：本地放行 ⟺ 内核接受（无漂移）', () => {
    for (const [label, operation] of MATRIX) {
      const localAccepts = EditIntent.localRejection(operation) === null;
      const kernel = compileEditIntent({ steps: [{ range: '第1段', operation }] });
      expect(localAccepts, `${label} 本地/内核判定不一致：${JSON.stringify(operation)}`).toBe(kernel.ok);
    }
  });

  it('正向：字体 / 字号控件产出的 step 直喂内核真实编译器必须被接受', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['fonts', { ascii: 'Times New Roman', eastAsia: '宋体' }],
      ['fonts', { eastAsia: '微软雅黑' }],
      ['size', { kind: 'pt', value: 12 }],
      ['size', { kind: 'pt', value: 10.5 }],
      ['size', { kind: 'chinese', name: '小四' }],
    ];
    for (const [controlId, value] of cases) {
      const built = EditIntent.buildStep('第1段', controlId, value);
      expect(built.ok, `${controlId} 应当可提交：${built.message ?? ''}`).toBe(true);
      if (!built.ok || built.step === undefined) throw new Error('不应通过');
      const verdict = compileEditIntent({ steps: [built.step] });
      expect(
        verdict.ok,
        `内核拒绝了页面敢提交的 setValue：${JSON.stringify(built.step.operation)}`,
      ).toBe(true);
    }
  });

  it('反向：非法值本地就拒（不发注定 422 的请求），内核也同样拒', () => {
    const bad: ReadonlyArray<readonly [string, unknown]> = [
      ['size', { kind: 'pt', value: 12.3 }],
      ['size', { kind: 'chinese', name: '特大号' }],
      ['size', { kind: 'em', value: 1 }],
      ['fonts', {}],
      ['fonts', { ascii: '   ' }],
    ];
    for (const [controlId, value] of bad) {
      const built = EditIntent.buildStep('第1段', controlId, value);
      expect(built.ok, `${controlId} 不应可提交：${JSON.stringify(value)}`).toBe(false);
      expect(built.code).toBe('invalid_value');
    }
  });
});

describe('edit-intent.js：暂存栈（提交前的撤销 / 重做）', () => {
  function step(label: string): { range: string; operation: Record<string, unknown> } {
    return { range: label, operation: { kind: 'clearDirectFormat' } };
  }

  it('add / undo / redo 的语义固定，且撤销后新增会切断重做分支', () => {
    const staging = EditIntent.createStaging();
    expect(staging.canUndo()).toBe(false);
    expect(staging.canRedo()).toBe(false);

    staging.add(step('a'));
    staging.add(step('b'));
    expect(staging.size()).toBe(2);

    expect(staging.undo()?.range).toBe('b');
    expect(staging.size()).toBe(1);
    expect(staging.canRedo()).toBe(true);
    expect(staging.redo()?.range).toBe('b');
    expect(staging.size()).toBe(2);

    staging.undo();
    staging.add(step('c'));
    expect(staging.canRedo()).toBe(false);
    expect(staging.steps().map((entry) => entry.range)).toEqual(['a', 'c']);
  });

  it('内容不自动提交：栈再多步，也只有 toIntent() 时才是**一个** intent', () => {
    const staging = EditIntent.createStaging();
    staging.add(step('第1段'));
    staging.add(step('第2段'));
    staging.add(step('第3段'));
    const intent = staging.toIntent();
    expect(intent.steps).toHaveLength(3);
    expect(intent.steps.map((entry) => entry.range)).toEqual(['第1段', '第2段', '第3段']);
  });

  it('超过上限时拒绝新增并说明原因（不静默丢弃）', () => {
    const staging = EditIntent.createStaging({ limit: 2 });
    expect(staging.add(step('a')).ok).toBe(true);
    expect(staging.add(step('b')).ok).toBe(true);
    const third = staging.add(step('c'));
    expect(third.ok).toBe(false);
    expect(third.code).toBe('too_many_steps');
    expect(staging.size()).toBe(2);
  });

  it('clear 返回被丢掉的步骤，便于如实告知用户', () => {
    const staging = EditIntent.createStaging();
    staging.add(step('a'));
    staging.add(step('b'));
    expect(staging.clear().map((entry) => entry.range)).toEqual(['a', 'b']);
    expect(staging.size()).toBe(0);
    expect(staging.undoneCount()).toBe(0);
  });
});

describe('edit-intent.js：回执分类（不把失败说成成功）', () => {
  it('只有真的发布了新版本才算"已保存"', () => {
    const applied = EditIntent.classifyEditResponse(200, {
      sessionId: 's1', replayed: false, noOp: false, editRevision: 4,
      steps: [{ range: '第1段', domain: 'paragraph', hitCount: 1, changed: true }],
      version: { editRevision: 4 },
    });
    expect(applied.kind).toBe('applied');
    expect(applied.showsSuccess).toBe(true);
    expect(applied.keepsStaged).toBe(false);

    const noOp = EditIntent.classifyEditResponse(200, {
      sessionId: 's1', replayed: false, noOp: true, editRevision: 4, steps: [], version: null,
    });
    expect(noOp.kind).toBe('no_op');
    expect(noOp.showsSuccess).toBe(false);

    const replayed = EditIntent.classifyEditResponse(200, {
      sessionId: 's1', replayed: true, noOp: false, editRevision: 4, steps: [], version: null,
    });
    expect(replayed.kind).toBe('replayed');
    expect(replayed.showsSuccess).toBe(false);
  });

  it('stale_revision：判为冲突、不显示成功、**保留**待保存状态并带出当前版本', () => {
    const conflict = EditIntent.classifyEditResponse(409, {
      code: 'stale_revision',
      message: '基线已过期',
      retryable: true,
      currentRevision: 7,
      requestedRevision: 5,
      reason: 'revision',
    });
    expect(conflict.kind).toBe('conflict');
    expect(conflict.showsSuccess).toBe(false);
    expect(conflict.keepsStaged).toBe(true);
    expect(conflict.currentRevision).toBe(7);
    expect(conflict.requestedRevision).toBe(5);
    expect(conflict.reason).toBe('revision');
    expect(conflict.note ?? '').toContain('没有改动文档');
  });

  it('结构化拒绝 / 下游失败都不显示成功，且保留步骤', () => {
    const unsupported = EditIntent.classifyEditResponse(422, {
      code: 'unsupported', message: '这一步不支持', retryable: false,
    });
    expect(unsupported.kind).toBe('rejected');
    expect(unsupported.showsSuccess).toBe(false);
    expect(unsupported.keepsStaged).toBe(true);

    const failed = EditIntent.classifyEditResponse(502, {
      code: 'publish_failed', message: '发布失败', retryable: true,
    });
    expect(failed.kind).toBe('failed');
    expect(failed.showsSuccess).toBe(false);
    expect(failed.keepsStaged).toBe(true);
    expect(failed.retryable).toBe(true);

    const unknown = EditIntent.classifyEditResponse(0, null);
    expect(unknown.kind).toBe('failed');
    expect(unknown.showsSuccess).toBe(false);
  });

  it('逐步回执如实区分"已改动"与"命中但空转"', () => {
    const text = EditIntent.describeReports([
      { range: '第2段', domain: 'character', hitCount: 1, changed: true, toggleTarget: 'on' },
      { range: '第3段', domain: 'paragraph', hitCount: 1, changed: false },
    ]);
    expect(text).toContain('第2段：命中 1 段，已改动');
    expect(text).toContain('目标为开启');
    expect(text).toContain('第3段：命中 1 段，无变化（已是目标状态）');
  });

  it('幂等键长度不超过合同的标识符上限', () => {
    const key = EditIntent.newKey('edit');
    expect(key.startsWith('edit-')).toBe(true);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(EditIntent.toIntent([{ range: '第1段' }]).steps).toHaveLength(1);
  });
});
