/**
 * FA-U —— 网页侧交付模块（`apps/demo/web/deliverable-ops.js`）的**纯逻辑**测试。
 *
 * 这一组不接网络：它守的是三件容易悄悄漂移的事——
 *  ① **请求形状**：路径、方法、请求体字段必须与服务端契约逐字一致（页面与验收共用同一份计划）；
 *  ② **结构化记法**：逐行记法必须解析成**封闭编辑枚举**里的对象，坏行必须报错而不是被静默丢掉；
 *  ③ **完成口径的呈现**：完成与成功分两行；`completed` 与服务端的三个谓词一一对应。
 *
 * 载入方式与既有网页测试一致：`node:vm` 跑**真实源码文件**（不是复述一份接口）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './support.js';
import { loadWebGlobal } from './word-ui/harness.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

interface DeliverablesModule {
  readonly FORMATS: readonly { value: string; extension: string; mime: string; templateKind: string }[];
  formatSpec(format: string): { value: string; extension: string; mime: string; templateKind: string } | null;
  pathOpen(): string;
  pathEdits(sessionId: string): string;
  pathDownload(sessionId: string, editRevision: number): string;
  pathCompletion(sessionId: string): string;
  planOpen(input: Record<string, unknown>): { method: string; path: string; body: Record<string, unknown> };
  planEdit(input: Record<string, unknown>): { method: string; path: string; body: Record<string, unknown> };
  planDownload(input: Record<string, unknown>): { method: string; path: string };
  planCompletion(input: Record<string, unknown>): { method: string; path: string };
  planStatus(input: Record<string, unknown>): { method: string; path: string };
  parseEdits(format: string, text: string): { ok: boolean; edits: readonly Record<string, unknown>[]; errors: readonly string[] };
  cellValueOf(raw: string): Record<string, unknown>;
  editHintFor(format: string): string;
  safeId(prefix: string, nowMs: number, salt?: string): string;
  describeDelivery(sessionId: string, body: Record<string, unknown>): Record<string, unknown> | null;
  describeFailure(status: number, body: Record<string, unknown>): { code: string; message: string; retryable: boolean; text: string };
  labelForCompletion(view: unknown): {
    completed: boolean;
    label: string;
    labelText: string;
    detail: string;
    completedText: string;
    successText: string;
    predicates: Record<string, boolean>;
  } | null;
}

const Lib = loadWebGlobal<DeliverablesModule>('deliverable-ops.js', 'PotbotDeliverables');

// ---------------------------------------------------------------------------

describe('请求形状与服务端契约一致（页面与验收共用同一份计划）', () => {
  it('路径就是 /api/deliverables/**，没有第二个前缀', () => {
    expect(Lib.pathOpen()).toBe('/api/deliverables');
    expect(Lib.pathEdits('s1')).toBe('/api/deliverables/s1/edits');
    expect(Lib.pathDownload('s1', 3)).toBe('/api/deliverables/s1/versions/3/download');
    expect(Lib.pathCompletion('s1')).toBe('/api/deliverables/s1/completion');
  });

  it('路径参数做了 URI 编码（中文会话 id 不会把路径拼坏）', () => {
    expect(Lib.pathEdits('会话 一')).toBe('/api/deliverables/' + encodeURIComponent('会话 一') + '/edits');
  });

  it('planOpen 的请求体就是契约里的四个必填字段（title 为空时不发）', () => {
    const plan = Lib.planOpen({
      sessionId: 's1', deliverableId: 'd1', filename: '台账.xlsx', format: 'xlsx',
    });
    expect(plan.method).toBe('POST');
    expect(plan.path).toBe('/api/deliverables');
    expect(Object.keys(plan.body).sort()).toEqual(['deliverableId', 'filename', 'format', 'sessionId']);

    const withTitle = Lib.planOpen({
      sessionId: 's1', deliverableId: 'd1', filename: '台账.xlsx', format: 'xlsx', title: '季度台账',
    });
    expect(withTitle.body['title']).toBe('季度台账');
  });

  it('planEdit 带四个必填字段：幂等键 + 基线与摘要 + 编辑', () => {
    const plan = Lib.planEdit({
      sessionId: 's1', idempotencyKey: 'k1', baseRevision: 0, baseDigest: 'a'.repeat(64),
      edit: { op: 'add_sheet', name: '明细' },
    });
    expect(plan.method).toBe('POST');
    expect(plan.path).toBe('/api/deliverables/s1/edits');
    expect(Object.keys(plan.body).sort()).toEqual(['baseDigest', 'baseRevision', 'edit', 'idempotencyKey']);
  });

  it('下载与完成口径都是 GET（完成口径没有写方法）', () => {
    const download = Lib.planDownload({ sessionId: 's1', editRevision: 2 });
    expect(download.method).toBe('GET');
    expect(download.path).toBe('/api/deliverables/s1/versions/2/download');
    expect('body' in download).toBe(false);

    const completion = Lib.planCompletion({ sessionId: 's1' });
    expect(completion.method).toBe('GET');
    expect(completion.path).toBe('/api/deliverables/s1/completion');
  });

  it('格式轴：扩展名与 MIME 各自正确且互不相同', () => {
    expect(Lib.formatSpec('xlsx')?.mime).toBe(XLSX_MIME);
    expect(Lib.formatSpec('pptx')?.mime).toBe(PPTX_MIME);
    expect(Lib.formatSpec('xlsx')?.extension).toBe('.xlsx');
    expect(Lib.formatSpec('pptx')?.extension).toBe('.pptx');
    expect(Lib.formatSpec('xlsx')?.templateKind).toBe('spreadsheet');
    expect(Lib.formatSpec('pptx')?.templateKind).toBe('presentation');
    expect(Lib.formatSpec('docx'), '本入口刻意不提供 Word（走写作入口）').toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('结构化记法 → 封闭编辑枚举（不做自然语言翻译，R134）', () => {
  it('表格：`表名 | 地址 | 值` 解析成 set_cell；`+表名` 解析成 add_sheet', () => {
    const parsed = Lib.parseEdits('xlsx', ['+明细', 'Sheet1 | A1 | 季度'].join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.edits).toEqual([
      { op: 'add_sheet', name: '明细' },
      { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '季度' } },
    ]);
  });

  it('表格：纯数字按数值写入，其他按文本', () => {
    expect(Lib.cellValueOf('2026')).toEqual({ kind: 'number', value: 2026 });
    expect(Lib.cellValueOf('-1.5')).toEqual({ kind: 'number', value: -1.5 });
    expect(Lib.cellValueOf('2026年')).toEqual({ kind: 'text', value: '2026年' });
    expect(Lib.cellValueOf('TRUE')).toEqual({ kind: 'boolean', value: true });
  });

  it('表格：值里含 `|` 不会被切碎', () => {
    const parsed = Lib.parseEdits('xlsx', 'Sheet1 | A1 | 甲 | 乙');
    expect(parsed.ok).toBe(true);
    expect((parsed.edits[0]?.['value'] as Record<string, unknown>)['value']).toBe('甲 | 乙');
  });

  it('演示：一行一页；空行与 # 注释都跳过', () => {
    const parsed = Lib.parseEdits('pptx', ['封面', '', '# 注释', '数据', '  '].join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.edits).toEqual([
      { op: 'add_slide', title: '封面' },
      { op: 'add_slide', title: '数据' },
    ]);
  });

  it('坏行必须报错（行号 + 原因），而不是被静默丢掉', () => {
    const parsed = Lib.parseEdits('xlsx', ['Sheet1 | A1 | ok', '这一行不是合法记法'].join('\n'));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.length).toBe(1);
    expect(parsed.errors[0]).toContain('第 2 行');
    // 合法的那些仍然在：报错不等于全丢，但 ok=false 会让页面**拒绝提交**。
    expect(parsed.edits.length).toBe(1);
  });

  it('一条编辑都没有 ⇒ ok=false（不提交空交付）', () => {
    expect(Lib.parseEdits('xlsx', '# 只有注释').ok).toBe(false);
    expect(Lib.parseEdits('pptx', '').ok).toBe(false);
  });

  it('两种格式的记法说明不同（页面据此提示用户，避免猜格式）', () => {
    expect(Lib.editHintFor('pptx')).not.toBe(Lib.editHintFor('xlsx'));
    expect(Lib.editHintFor('xlsx')).toContain('表名');
  });
});

// ---------------------------------------------------------------------------

describe('完成口径的呈现：完成与成功分开（R263）', () => {
  function view(label: string, completed: boolean): Record<string, unknown> {
    return {
      completed,
      label,
      labelText: label,
      detail: 'detail',
      predicates: { allWorkItemsTerminal: true, noInFlightRuns: true, noUnresolvedActions: true },
    };
  }

  it('四个标签各有自己的"成功"说法，且都不与"完成"那句话重合', () => {
    const labels = [
      'completed_and_successful',
      'completed_with_unfinished_business',
      'completed_and_cancelled',
      'not_completed',
    ];
    const seen = new Set<string>();
    for (const label of labels) {
      const info = Lib.labelForCompletion(view(label, label !== 'not_completed'));
      expect(info).not.toBeNull();
      expect(info?.label).toBe(label);
      expect((info?.successText ?? '').length).toBeGreaterThan(0);
      expect(info?.completedText).not.toBe(info?.successText);
      seen.add(info?.successText ?? '');
    }
    expect(seen.size, '四种口径的"成功"说法必须互不相同').toBe(4);
  });

  it('成功只对应"已完成且成功"；被取消不能落进成功那一句', () => {
    const ok = Lib.labelForCompletion(view('completed_and_successful', true));
    const cancelled = Lib.labelForCompletion(view('completed_and_cancelled', true));
    expect(ok?.successText).toContain('办成了');
    expect(cancelled?.successText).not.toContain('办成了');
    // 但两者都"已完成"——完成与成功确实是两件事。
    expect(ok?.completedText).toBe(cancelled?.completedText);
  });

  it('三个谓词原样透传（用户可自己复算），缺项按未成立处理', () => {
    const info = Lib.labelForCompletion({
      completed: false,
      label: 'not_completed',
      labelText: '尚未完成',
      detail: '还有在途轮次',
      predicates: { allWorkItemsTerminal: true, noInFlightRuns: false },
    });
    expect(info?.predicates).toEqual({
      allWorkItemsTerminal: true,
      noInFlightRuns: false,
      noUnresolvedActions: false,
    });
    expect(info?.completedText).toContain('尚未完成');
  });

  it('响应形状不认识时返回 null（宁可什么都不显示，也不编一个结论）', () => {
    expect(Lib.labelForCompletion(null)).toBeNull();
    expect(Lib.labelForCompletion(undefined)).toBeNull();
    expect(Lib.labelForCompletion('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('回执与失败：一律取服务端原话', () => {
  it('describeDelivery 只搬服务端给的字段，缺项就是 null（不填看起来合理的值）', () => {
    const described = Lib.describeDelivery('s1', {
      editRevision: 2,
      replayed: false,
      version: {
        filename: '台账.xlsx', fileFormat: 'xlsx', mimeType: XLSX_MIME,
        templateKind: 'spreadsheet', byteLength: 1234, contentDigest: 'a'.repeat(64), artifactId: 'A-1',
      },
    });
    expect(described?.['filename']).toBe('台账.xlsx');
    expect(described?.['mimeType']).toBe(XLSX_MIME);
    expect(described?.['byteLength']).toBe(1234);

    const minimal = Lib.describeDelivery('s1', { editRevision: 1, version: {} });
    expect(minimal?.['filename']).toBeNull();
    expect(minimal?.['mimeType']).toBeNull();
    expect(minimal?.['byteLength']).toBeNull();

    expect(Lib.describeDelivery('s1', { editRevision: 1, version: null }), '没有映射行 ⇒ 不编').toBeNull();
  });

  it('describeFailure 保留服务端 code/message/retryable', () => {
    const failure = Lib.describeFailure(409, { code: 'stale_revision', message: '基线已过期', retryable: false });
    expect(failure.code).toBe('stale_revision');
    expect(failure.message).toBe('基线已过期');
    expect(failure.retryable).toBe(false);
    expect(failure.text).toContain('HTTP 409');
    expect(failure.text).toContain('不可重试');
  });

  it('服务端没给说明时如实说"没给"，且**不替它认领**是否可重试', () => {
    const failure = Lib.describeFailure(500, {});
    expect(failure.message).toContain('没有给出说明');
    expect(failure.retryable, '没说就是没说，不默认成 false').toBeNull();
    expect(failure.text).toContain('没有说明是否可重试');
  });

  it('safeId 只产出契约允许的安全字符（1–128 位）', () => {
    const id = Lib.safeId('web-xlsx', Date.now(), 'a/b c');
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toContain('web-xlsx');
  });
});

// ---------------------------------------------------------------------------

/**
 * 接线完整性（**静态**判据）。
 *
 * ⚠️ 诚实边界：这一组**不执行 `app.js`**——它读源码与页面结构，只回答
 * "入口在不在、接没接上、有没有绕开既有取回核对链"。
 * "点击之后真的发出这些请求"这一层由 `fa-u-deliverables-e2e.test.ts` 用
 * **同一批计划**直喂真实宿主来证明（那一组会真跑）。
 *
 * 为什么不直接跑 `app.js`：既有夹具 `createAppHarness` 的 `fetch` 桩只认少数几条路由，
 * 而"给它加可插拔脚本与路由"要改动一个被大量既有用例共用的夹具——那会把
 * 已「待验收」的证据面重新解冻。**宁可说清这一层是静态的，也不动别人的证据面。**
 */
describe('接线完整性：入口在页面里、且没有绕开既有链', () => {
  const html = readFileSync(join(REPO_ROOT, 'apps', 'demo', 'web', 'index.html'), 'utf8');
  const appJs = readFileSync(join(REPO_ROOT, 'apps', 'demo', 'web', 'app.js'), 'utf8');

  const REQUIRED_IDS = [
    'deliverable-format', 'deliverable-filename', 'deliverable-edit-input', 'deliverable-edit-hint',
    'deliverable-form-error', 'deliverable-submit-btn', 'deliverable-status',
    'deliverable-result', 'deliverable-result-filename', 'deliverable-result-format',
    'deliverable-result-mime', 'deliverable-result-size', 'deliverable-result-sha',
    'deliverable-download-btn', 'deliverable-download-status',
    'deliverable-completion', 'deliverable-completion-completed', 'deliverable-completion-success',
    'deliverable-completion-detail', 'deliverable-pred-work', 'deliverable-pred-runs',
    'deliverable-pred-actions',
  ];

  it('页面里有这些节点，且 app.js 缓存了同样的 id（两边不会各写一份）', () => {
    for (const id of REQUIRED_IDS) {
      expect(html, `index.html 缺节点 ${id}`).toContain(`id="${id}"`);
      expect(appJs, `app.js 没有缓存 ${id}`).toContain(`'${id}'`);
    }
  });

  it('入口落在**既有的七个视图**之一（任务视图）里，不是另开一个页面', () => {
    const taskViewIndex = html.indexOf('id="view-tasks"');
    const entryIndex = html.indexOf('id="deliverable-submit-btn"');
    expect(taskViewIndex).toBeGreaterThan(-1);
    expect(entryIndex).toBeGreaterThan(taskViewIndex);
    // 入口与任务视图之间不得再出现另一个视图容器 —— 那就说明它确实在这个视图**内部**，
    // 而不是被放到了视图外面（视图外的东西在切视图时不会跟着显示）。
    const between = html.slice(taskViewIndex + 1, entryIndex);
    // `view-state-<id>` 是视图**内部**的状态节点，不算新视图容器；排除它。
    expect(/id="view-(?!state-)/.test(between), '入口应落在 view-tasks 内部，而不是另一个视图里').toBe(false);
  });

  it('模块在 app.js **之前**加载（否则 app.js 初始化时拿不到它）', () => {
    const opsIndex = html.indexOf('./deliverable-ops.js');
    const appIndex = html.indexOf('./app.js');
    expect(opsIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeGreaterThan(opsIndex);
  });

  it('按钮真的接了事件（不是"页面有按钮但点了没反应"）', () => {
    expect(appJs).toMatch(/'deliverable-submit-btn'\]\.addEventListener\('click', submitDeliverable\)/);
    expect(appJs).toMatch(/'deliverable-download-btn'\]\.addEventListener\('click', downloadDeliverable\)/);
    expect(appJs).toMatch(/'deliverable-format'\]\.addEventListener\('change'/);
  });

  it('交付结果走**同一个**取回核对流程（新路径不绕开摘要核对）', () => {
    const downloadFn = /function downloadDeliverable\(\)[\s\S]*?\n  \}/.exec(appJs);
    expect(downloadFn, '找不到 downloadDeliverable').not.toBeNull();
    expect(downloadFn?.[0]).toContain('verifyAndSaveBytes');
    // 且必须用**服务端映射行**里的 MIME，而不是页面上的常量。
    expect(downloadFn?.[0]).toContain('mimeType');
    expect(downloadFn?.[0]).not.toContain('DOCX_MIME');
  });

  it('完成口径的三个谓词逐条渲染（用户可自己复算，而不是只看一个结论词）', () => {
    for (const key of ['allWorkItemsTerminal', 'noInFlightRuns', 'noUnresolvedActions']) {
      expect(appJs, `app.js 没有渲染谓词 ${key}`).toContain(key);
    }
    expect(appJs).toMatch(/'deliverable-pred-work'/);
    expect(appJs).toMatch(/'deliverable-pred-runs'/);
    expect(appJs).toMatch(/'deliverable-pred-actions'/);
  });

  it('页面侧没有任何"把任务置为完成"的写口', () => {
    expect(appJs).not.toMatch(/setCompleted|markCompleted|completeTask/i);
    expect(appJs).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/);
  });
});
