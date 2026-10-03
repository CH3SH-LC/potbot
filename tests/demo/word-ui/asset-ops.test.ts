/**
 * APP-04（任务与文件）纯逻辑判据 —— 打在**线上那一份** `apps/demo/web/asset-ops.js` 上。
 *
 * 判据的核心不是"功能有没有"，而是**"什么时候不算成功"**：
 *   ① 取消 / 失权 / 过期 / 未授权 / 读回失败 ⇒ `showsSuccess === false`；
 *   ② `stale_revision` **即使字节核验通过也不是成功**（否则旧版本会被冒充成最新件）；
 *   ③ 未算摘要（`digest_unavailable`）**不得**被说成「已核验」。

 * 每个"不算成功"的分支都配一个反向对照（真的通过时必须为 true），避免断言恒假。
 */

import { describe, expect, it } from 'vitest';

import { loadWebGlobal, loadDownloadVerifyModule } from './harness.js';

interface UriOutcome {
  readonly code: string;
  readonly showsSuccess: boolean;
  readonly message: string;
  readonly action: string;
}

interface UriRecord {
  operationId: string;
  documentId: string;
  revision: number | null;
  state: string;
  readback: unknown;
}

interface UriTracker {
  request(req: { documentId: string; uri?: string; revision?: number }): UriRecord;
  grant(id: string, info?: { persisted?: boolean }): UriRecord | null;
  cancel(id: string): UriRecord | null;
  revoke(id: string): UriRecord | null;
  expire(id: string): UriRecord | null;
  readback(id: string, info: { ok: boolean; currentRevision?: number; verdict?: unknown }): UriRecord | null;
  stateOf(id: string): string | null;
  evaluate(id: string): UriOutcome;
  usable(id: string): boolean;
  records(): UriRecord[];
}

interface AssetOps {
  HANDOFF_TARGETS: Record<string, string>;
  URI_STATES: Record<string, string>;
  OUTCOME: Record<string, string>;
  extensionOf(name: unknown): string;
  handoffTargetFor(name: unknown): { ext: string; target: string; known: boolean };
  searchEntries(entries: unknown, query: unknown): {
    query: string; hasQuery: boolean; matched: Array<Record<string, unknown>>; total: number;
  };
  versionHistory(entry: unknown): Array<{ revision: number; isLatest: boolean; label: string }>;
  validateRename(name: unknown, existing: unknown): { ok: boolean; code: string; name: string };
  isGrantLive(state: string): boolean;
  evaluateUriAction(input: unknown): UriOutcome;
  createUriGrantTracker(opts?: unknown): UriTracker;
  availableActions(entry: unknown, ctx: unknown): Array<{ id: string; enabled: boolean; reason: string }>;
  describeOutcome(code: string): { text: string; action: string };
}

const Asset = loadWebGlobal<AssetOps>('asset-ops.js', 'PotbotAssetOps');
const Download = loadDownloadVerifyModule();

/** 造一个"摘要已算出且一致"的核验结果，走真实分类器。 */
function verifiedVerdict(): unknown {
  return Download.classifyDownload({
    expectedByteLength: 12,
    actualByteLength: 12,
    expectedSha256: 'ab'.repeat(32),
    actualSha256: 'ab'.repeat(32),
  });
}

function unverifiedVerdict(): unknown {
  // 长度一致但**算不出摘要**
  return Download.classifyDownload({
    expectedByteLength: 12,
    actualByteLength: 12,
    expectedSha256: 'ab'.repeat(32),
    actualSha256: null,
  });
}

describe('APP-04 交接目标：三种办公格式各有正确消费者', () => {
  it('docx/xlsx/pptx 各自映射到不同消费者，且都 known', () => {
    expect(Asset.handoffTargetFor('邀请函.docx').target).toBe('Word / WPS 文字');
    expect(Asset.handoffTargetFor('报表.XLSX').target).toBe('Excel / WPS 表格');
    expect(Asset.handoffTargetFor('路演.pptx').target).toBe('PowerPoint / WPS 演示');
    for (const name of ['a.docx', 'a.xlsx', 'a.pptx']) {
      expect(Asset.handoffTargetFor(name).known).toBe(true);
    }
  });

  it('未登记的格式说「不认识」，不猜一个软件名', () => {
    const result = Asset.handoffTargetFor('archive.zip');
    expect(result.known).toBe(false);
    expect(result.target).toBe('');
  });

  it('扩展名解析：大小写归一、无扩展名/隐藏文件返回空串', () => {
    expect(Asset.extensionOf('a/b/c.DOCX')).toBe('docx');
    expect(Asset.extensionOf('noext')).toBe('');
    expect(Asset.extensionOf('.hidden')).toBe('');
    expect(Asset.extensionOf('trailing.')).toBe('');
  });
});

describe('APP-04 搜索：大小写不敏感、命中字段可追溯', () => {
  const entries = [
    { requestId: 'req-1', taskId: 'task-1', instruction: '写一封读书会邀请函', filename: '邀请函.docx' },
    { requestId: 'req-2', taskId: 'task-2', instruction: '生成季度报表', filename: '报表.xlsx' },
  ];

  it('空查询返回全部，并如实标 hasQuery=false', () => {
    const result = Asset.searchEntries(entries, '   ');
    expect(result.hasQuery).toBe(false);
    expect(result.matched).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('按文件名子串匹配且大小写不敏感', () => {
    const result = Asset.searchEntries(entries, 'DOCX');
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.['requestId']).toBe('req-1');
    expect(result.matched[0]?.['matchedOn']).toBe('filename');
  });

  it('按任务编号匹配', () => {
    const result = Asset.searchEntries(entries, 'task-2');
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]?.['matchedOn']).toBe('taskId');
  });

  it('无匹配时返回空数组（不是回退成全量）', () => {
    expect(Asset.searchEntries(entries, 'zzz').matched).toEqual([]);
  });

  it('同一项命中多个字段只出现一次', () => {
    const result = Asset.searchEntries(
      [{ requestId: 'req-9', taskId: 'req-9', instruction: 'req-9', filename: 'req-9.docx' }],
      'req-9',
    );
    expect(result.matched).toHaveLength(1);
  });
});

describe('APP-04 历史版本：只列真实存在的版本', () => {
  it('没有 versions 数组 ⇒ 空数组（不按版本号凭空生成）', () => {
    expect(Asset.versionHistory({ revision: 7 })).toEqual([]);
    expect(Asset.versionHistory({})).toEqual([]);
    expect(Asset.versionHistory(null)).toEqual([]);
  });

  it('按 revision 降序，最新一条标 isLatest', () => {
    const rows = Asset.versionHistory({ versions: [{ revision: 1 }, { revision: 3 }, { revision: 2 }] });
    expect(rows.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(rows[0]?.isLatest).toBe(true);
    expect(rows[1]?.isLatest).toBe(false);
  });

  it('缺 revision 的记录被跳过，不冒充成一行版本', () => {
    const rows = Asset.versionHistory({ versions: [{ label: '幽灵版本' }, { revision: 2 }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe(2);
  });
});

describe('APP-04 重命名：只校验，不声称已改', () => {
  it('空名 / 超长 / 非法字符 / 重名各有独立错误码', () => {
    expect(Asset.validateRename('   ', []).code).toBe('empty_name');
    expect(Asset.validateRename('x'.repeat(121), []).code).toBe('too_long');
    expect(Asset.validateRename('a/b.docx', []).code).toBe('illegal_char');
    expect(Asset.validateRename('a\\b.docx', []).code).toBe('illegal_char');
    expect(Asset.validateRename('已存在.docx', ['已存在.docx']).code).toBe('duplicate');
  });

  it('正常名字通过并去掉首尾空白', () => {
    const result = Asset.validateRename('  读书会 邀请函.docx  ', []);
    expect(result.ok).toBe(true);
    expect(result.code).toBe('');
    expect(result.name).toBe('读书会 邀请函.docx');
  });

  it('名字里的空格与连字符合法（防止非法字符集写宽）', () => {
    expect(Asset.validateRename('读书会 邀请函 v2-最终.docx', []).ok).toBe(true);
  });
});

describe('APP-04 URI 读回判定：只有 readback_ok 才算成功', () => {
  it('反向对照：字节核验通过 + 版本一致 ⇒ showsSuccess=true', () => {
    const result = Asset.evaluateUriAction({
      grantState: 'granted_persisted', requestedRevision: 3, currentRevision: 3, verdict: verifiedVerdict(),
    });
    expect(result.code).toBe('readback_ok');
    expect(result.showsSuccess).toBe(true);
  });

  it('stale_revision：**即使核验通过也不算成功**', () => {
    const result = Asset.evaluateUriAction({
      grantState: 'granted_persisted', requestedRevision: 2, currentRevision: 3, verdict: verifiedVerdict(),
    });
    expect(result.code).toBe('stale_revision');
    expect(result.showsSuccess).toBe(false);
  });

  it('digest_unavailable：长度一致但没算摘要 ⇒ 不算成功，文案说明未核对', () => {
    const result = Asset.evaluateUriAction({
      grantState: 'granted_persisted', requestedRevision: 3, currentRevision: 3, verdict: unverifiedVerdict(),
    });
    expect(result.code).toBe('digest_unavailable');
    expect(result.showsSuccess).toBe(false);
    expect(result.message).toContain('未核对校验值');
  });

  it('取消 / 失权 / 过期 / 未授权：一律不算成功', () => {
    for (const state of ['cancelled', 'revoked', 'expired', 'not_requested', 'requested']) {
      const result = Asset.evaluateUriAction({
        grantState: state, requestedRevision: 3, currentRevision: 3, verdict: verifiedVerdict(),
      });
      expect(result.showsSuccess, `state=${state} 不得显示成功`).toBe(false);
    }
  });

  it('没有读回结果时不算成功', () => {
    const result = Asset.evaluateUriAction({ grantState: 'granted_persisted', requestedRevision: 1, currentRevision: 1 });
    expect(result.showsSuccess).toBe(false);
    expect(result.code).toBe('readback_failed');
  });
});

describe('APP-04 URI 台账：usable 与 showsSuccess 严格绑定', () => {
  it('刚申请、刚授予（未读回）时 usable 为 false', () => {
    const tracker = Asset.createUriGrantTracker({});
    const rec = tracker.request({ documentId: 'doc-1', revision: 3 });
    expect(tracker.usable(rec.operationId)).toBe(false);
    tracker.grant(rec.operationId, { persisted: true });
    expect(tracker.stateOf(rec.operationId)).toBe('granted_persisted');
    expect(tracker.usable(rec.operationId), '授权 ≠ 可用；还没有读回').toBe(false);
  });

  it('读回通过后 usable 才为 true', () => {
    const tracker = Asset.createUriGrantTracker({});
    const rec = tracker.request({ documentId: 'doc-1', revision: 3 });
    tracker.grant(rec.operationId, { persisted: true });
    tracker.readback(rec.operationId, { ok: true, currentRevision: 3, verdict: verifiedVerdict() });
    expect(tracker.usable(rec.operationId)).toBe(true);
    expect(tracker.evaluate(rec.operationId).code).toBe('readback_ok');
  });

  it('读回通过后撤销 ⇒ 立刻不再可用，且结论不是成功', () => {
    const tracker = Asset.createUriGrantTracker({});
    const rec = tracker.request({ documentId: 'doc-1', revision: 3 });
    tracker.grant(rec.operationId, { persisted: true });
    tracker.readback(rec.operationId, { ok: true, currentRevision: 3, verdict: verifiedVerdict() });
    expect(tracker.usable(rec.operationId)).toBe(true);
    tracker.revoke(rec.operationId);
    expect(tracker.usable(rec.operationId)).toBe(false);
    expect(tracker.evaluate(rec.operationId).showsSuccess).toBe(false);
    expect(tracker.evaluate(rec.operationId).code).toBe('revoked');
  });

  it('读回针对旧版本 ⇒ 不可用，且码是 stale_revision', () => {
    const tracker = Asset.createUriGrantTracker({});
    const rec = tracker.request({ documentId: 'doc-1', revision: 2 });
    tracker.grant(rec.operationId, { persisted: false });
    tracker.readback(rec.operationId, { ok: true, currentRevision: 3, verdict: verifiedVerdict() });
    expect(tracker.evaluate(rec.operationId).code).toBe('stale_revision');
    expect(tracker.usable(rec.operationId)).toBe(false);
  });

  it('cancel 后即使之前读回通过也不可用（终态清空读回结论）', () => {
    const tracker = Asset.createUriGrantTracker({});
    const rec = tracker.request({ documentId: 'doc-1', revision: 3 });
    tracker.grant(rec.operationId, { persisted: true });
    tracker.readback(rec.operationId, { ok: true, currentRevision: 3, verdict: verifiedVerdict() });
    tracker.cancel(rec.operationId);
    expect(tracker.usable(rec.operationId)).toBe(false);
    expect(tracker.evaluate(rec.operationId).code).toBe('cancelled');
  });
});

describe('APP-04 可用动作：不可用时必须给原因', () => {
  const file = { filename: '报表.xlsx' };

  it('未读回 ⇒ 打开/另存/分享不可用，且各带原因', () => {
    const actions = Asset.availableActions(file, { usable: false, hasVersions: false, readOnly: false });
    for (const id of ['open', 'saveAs', 'share']) {
      const action = actions.find((a) => a.id === id);
      expect(action?.enabled, `${id} 不应可用`).toBe(false);
      expect(action?.reason.length, `${id} 应给出原因`).toBeGreaterThan(0);
    }
    const history = actions.find((a) => a.id === 'history');
    expect(history?.enabled).toBe(false);
    expect(history?.reason).toContain('服务端');
  });

  it('反向对照：读回通过 + 有版本 ⇒ 打开/另存/分享/历史版本全可用', () => {
    const actions = Asset.availableActions(file, { usable: true, hasVersions: true, readOnly: false });
    for (const action of actions) {
      expect(action.enabled, `${action.id} 应可用`).toBe(true);
      expect(action.reason).toBe('');
    }
  });

  it('格式没有登记消费者时，打开与分享不可用（另存仍可用）', () => {
    const actions = Asset.availableActions({ filename: 'x.zip' }, { usable: true, hasVersions: false, readOnly: false });
    expect(actions.find((a) => a.id === 'open')?.enabled).toBe(false);
    expect(actions.find((a) => a.id === 'share')?.enabled).toBe(false);
    expect(actions.find((a) => a.id === 'saveAs')?.enabled).toBe(true);
  });

  it('只读条目不能重命名', () => {
    const actions = Asset.availableActions(file, { usable: true, hasVersions: false, readOnly: true });
    expect(actions.find((a) => a.id === 'rename')?.enabled).toBe(false);
  });
});

describe('APP-04 结果文案：取消/失权说清「没有产生结果」', () => {
  it('取消与失权的文案都不含"成功/完成"这类误导词', () => {
    for (const code of ['cancelled', 'revoked', 'expired', 'not_granted', 'stale_revision']) {
      const described = Asset.describeOutcome(code);
      expect(described.text).not.toMatch(/成功|已完成/);
      expect(described.action.length).toBeGreaterThan(0);
    }
  });

  it('readback_ok 是唯一会被描述成完成的码', () => {
    expect(Asset.describeOutcome('readback_ok').text).toContain('完成');
  });
});
