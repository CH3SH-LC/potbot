/**
 * 通用交付会话的单元测试（design-06 P8/P9）。
 *
 * 覆盖三类**单靠宿主测试抓不住**的风险：
 *
 * 1. **状态编解码**：表格的源里有 `ReadonlyMap`（单元格）与 `Uint8Array`（R249 保留部件的
 *    原始字节），裸 `JSON.stringify` 分别会变成 `{}` 与数字键对象——**不报错，只是悄悄毁掉**。
 *    这里对"编码 → JSON 往返 → 解码"整条路做逐项断言，并带一个**反向对照**
 *    （故意退化成裸 JSON 时，`Map` 必须真的丢）。
 * 2. **恢复的三道核对**：schema / 身份与格式 / **重新导出与落盘摘要一致**。
 * 3. **格式守卫**（R232）：文件名扩展名、格式与模板种类的自洽。
 */

import { describe, expect, it } from 'vitest';

import type { DeliverableAdapter } from './adapter.js';
import {
  FILE_FORMATS,
  FILE_FORMAT_SPECS,
  assertFilenameMatchesFormat,
  filenameMatchesFormat,
  formatOfFilename,
  formatOfTemplateKind,
  isFileFormat,
  templateKindOfFormat,
} from './formats.js';
import { decodeSessionState, encodeSessionState } from './persistence.js';
import { DeliverableSession } from './session.js';
import type {
  DeliverablePublishPort,
  DeliverableSessionState,
  SessionPersistence,
} from './types.js';

// ---------------------------------------------------------------------------
// 夹具：一个最小的"文本行"格式（刻意与三种办公格式无关）
// ---------------------------------------------------------------------------

interface LineSource {
  readonly lines: string[];
  /** 刻意放一个 `Map` 与一个 `Uint8Array`：正是真实源里最容易静默丢数据的两种值。 */
  readonly index: ReadonlyMap<string, number>;
  readonly blob: Uint8Array;
}

/** 一个假格式：`.docx` 扩展名（借它的元数据），但源是自己的形状。 */
const fakeAdapter: DeliverableAdapter<LineSource> = Object.freeze({
  format: 'docx',
  template_kind: 'document',
  describe: (source: LineSource): string => `${String(source.lines.length)} 行`,
  exportBytes: (source: LineSource) => {
    // 用 node:crypto 直接算（本测试不依赖生产实现的摘要口径）。
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const bytes = new Uint8Array(Buffer.from(source.lines.join('\n'), 'utf8'));
    return {
      ok: true as const,
      bytes,
      entry_count: source.lines.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  },
  applyEdit: (source: LineSource, edit: unknown) => {
    if (
      typeof edit !== 'object' ||
      edit === null ||
      (edit as { op?: unknown }).op !== 'append_line' ||
      typeof (edit as { text?: unknown }).text !== 'string'
    ) {
      return { ok: false as const, kind: 'unsupported_op', detail: '只支持 append_line' };
    }
    const text = (edit as { text: string }).text;
    const index = new Map(source.index);
    index.set(text, source.lines.length);
    return {
      ok: true as const,
      source: { ...source, lines: [...source.lines, text], index },
      changed: true,
      notes: Object.freeze([`追加了 ${text}`]),
    };
  },
});

function seedSource(): LineSource {
  return {
    lines: ['甲', '乙'],
    index: new Map([
      ['甲', 0],
      ['乙', 1],
    ]),
    blob: new Uint8Array([1, 2, 3, 255]),
  };
}

function memoryPersistence(): { port: SessionPersistence; state: () => unknown } {
  let saved: unknown = null;
  return {
    port: {
      save(state: DeliverableSessionState): void {
        saved = encodeSessionState(state);
      },
      load(): unknown {
        // 模拟真实落盘：编码后的值还会过一次 JSON 文本。
        return saved === null ? null : (JSON.parse(JSON.stringify(saved)) as unknown);
      },
    },
    state: () => saved,
  };
}

/** 一个"总会成功"的发布端口（写盘与回读由它自己声称；本层不验证磁盘）。 */
function okPublishPort(): DeliverablePublishPort {
  let version = 0;
  return {
    publish: (request) => {
      version += 1;
      void request;
      return Promise.resolve({
        ok: true as const,
        receipt: Object.freeze({
          artifact_id: `artifact-${String(version)}`,
          task_revision: version,
          artifact_version: version,
          readback_digest: request.expected_digest,
          byte_length: request.bytes.byteLength,
          entry_count: 1,
          filename: request.filename,
          verifier: 'test',
          final_path: `/tmp/${request.filename}`,
        }),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 格式轴（R232）
// ---------------------------------------------------------------------------

describe('文件格式轴（R232：模板 / 工具 / 文件格式分开）', () => {
  it('三个格式的 MIME 与扩展名互不相同，且与 protocol 的单源一致', () => {
    const mimes = FILE_FORMATS.map((format) => FILE_FORMAT_SPECS[format].mime);
    expect(new Set(mimes).size).toBe(FILE_FORMATS.length);
    expect(FILE_FORMAT_SPECS.xlsx.extension).toBe('xlsx');
    expect(FILE_FORMAT_SPECS.xlsx.mime).toContain('spreadsheetml.sheet');
    expect(FILE_FORMAT_SPECS.pptx.mime).toContain('presentationml.presentation');
    expect(FILE_FORMAT_SPECS.docx.mime).toContain('wordprocessingml.document');
  });

  it('模板种类与文件格式是**两个轴**上的显式映射（不是同一个枚举）', () => {
    expect(formatOfTemplateKind('spreadsheet')).toBe('xlsx');
    expect(formatOfTemplateKind('presentation')).toBe('pptx');
    expect(templateKindOfFormat('xlsx')).toBe('spreadsheet');
    expect(isFileFormat('xlsx')).toBe(true);
    expect(isFileFormat('spreadsheet')).toBe(false); // 模板种类不是文件格式
  });

  it('从文件名推断格式：不猜（未知后缀返回 null）', () => {
    expect(formatOfFilename('a.xlsx')).toBe('xlsx');
    expect(formatOfFilename('A.PPTX')).toBe('pptx');
    expect(formatOfFilename('a.txt')).toBeNull();
    expect(formatOfFilename('xlsx')).toBeNull();
  });

  it('互不冒充：扩展名与声明格式不符即拒', () => {
    expect(() => assertFilenameMatchesFormat('xlsx', '台账.xlsx')).not.toThrow();
    expect(() => assertFilenameMatchesFormat('xlsx', '台账.xlsx.xlsx')).not.toThrow();
    expect(() => assertFilenameMatchesFormat('xlsx', '台账.pptx')).toThrow(/冒充/);
    expect(() => assertFilenameMatchesFormat('pptx', '台账')).toThrow(/扩展名/);
    expect(filenameMatchesFormat('pptx', 'deck.PPTX')).toBe(true);
    expect(filenameMatchesFormat('pptx', 'deck.xlsx')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------------------

describe('状态编解码（Map 与二进制不能被静默毁掉）', () => {
  it('`ReadonlyMap` 与 `Uint8Array` 经 JSON 往返后逐项还原', () => {
    const source = seedSource();
    const encoded = encodeSessionState(source);
    const text = JSON.stringify(encoded);
    const decoded = decodeSessionState(JSON.parse(text)) as LineSource;

    expect(decoded.lines).toEqual(['甲', '乙']);
    expect(decoded.index).toBeInstanceOf(Map);
    expect(decoded.index.get('甲')).toBe(0);
    expect(decoded.index.get('乙')).toBe(1);
    expect(decoded.blob).toBeInstanceOf(Uint8Array);
    expect([...decoded.blob]).toEqual([1, 2, 3, 255]);
  });

  it('**反向对照**：不走编解码器时，`Map` 真的会丢（证明上一条不是空转）', () => {
    const source = seedSource();
    const naive = JSON.parse(JSON.stringify(source)) as { index: unknown; blob: unknown };
    expect(naive.index).toEqual({}); // 裸 JSON 把 Map 写成空对象
    expect(Array.isArray(naive.blob) === false).toBe(true); // 且把字节写成数字键对象
    expect((naive.blob as Record<string, number>)['0']).toBe(1);
  });

  it('Map 的非标量键被**显式拒绝**（不静默拼成 `[object Object]`）', () => {
    const bad = new Map<unknown, unknown>([[{ a: 1 }, 'x']]);
    expect(() => encodeSessionState({ bad })).toThrow(/非标量键/);
  });

  it('解码对不认识的形状原样返回（不抛错、不丢数据）', () => {
    expect(decodeSessionState({ $bytes: 'not-base64!!' })).toEqual({ $bytes: 'not-base64!!' });
    expect(decodeSessionState({ $map: 'nope' })).toEqual({ $map: 'nope' });
  });
});

// ---------------------------------------------------------------------------
// 会话生命周期
// ---------------------------------------------------------------------------

describe('DeliverableSession：事务纪律', () => {
  it('新建 → 编辑发布 → 恢复（重开）后摘要一致', async () => {
    const persistence = memoryPersistence();
    const options = {
      id: 's1',
      deliverable_id: 'd1',
      filename: '记录.docx',
      adapter: fakeAdapter,
      persistence: persistence.port,
      publish_port: okPublishPort(),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    };
    const created = DeliverableSession.createNew(options, seedSource());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const session = created.value;

    const published = await session.publish({
      idempotency_key: 'k1',
      base_revision: 0,
      base_digest: session.currentDigest(),
      edit: { op: 'append_line', text: '丙' },
    });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) return;
    expect(published.value.changed).toBe(true);
    expect(published.value.notes).toEqual(['追加了 丙']);
    expect(session.currentRevision()).toBe(1);
    expect(session.status().published[0]?.mime_type).toBe(FILE_FORMAT_SPECS.docx.mime);

    // 恢复：从落盘状态重建，并重新导出核对摘要。
    const restored = DeliverableSession.restore({ ...options, publish_port: okPublishPort() });
    expect(restored.result.loaded, restored.result.reason).toBe(true);
    expect(restored.session?.currentRevision()).toBe(1);
    expect(restored.session?.currentDigest()).toBe(session.currentDigest());
    expect([...(restored.session?.source().index.keys() ?? [])]).toEqual(['甲', '乙', '丙']);
  });

  it('幂等重放：replayed=true、changed=false、不产生第二个版本', async () => {
    const persistence = memoryPersistence();
    const options = {
      id: 's2',
      deliverable_id: 'd2',
      filename: '记录.docx',
      adapter: fakeAdapter,
      persistence: persistence.port,
      publish_port: okPublishPort(),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    };
    const created = DeliverableSession.createNew(options, seedSource());
    if (!created.ok) throw new Error('unreachable');
    const session = created.value;
    const edit = { op: 'append_line', text: '丙' };

    const first = await session.publish({
      idempotency_key: 'same',
      base_revision: 0,
      base_digest: session.currentDigest(),
      edit,
    });
    expect(first.ok).toBe(true);
    const revisionAfterFirst = session.currentRevision();

    const second = await session.publish({
      idempotency_key: 'same',
      base_revision: 0,
      base_digest: session.currentDigest(),
      edit,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.changed).toBe(false);
    expect(session.currentRevision(), '重放不得产生第二个版本').toBe(revisionAfterFirst);
  });

  it('同一幂等键配不同输入 ⇒ idempotency_conflict（不静默吞掉真实改动）', async () => {
    const persistence = memoryPersistence();
    const options = {
      id: 's3',
      deliverable_id: 'd3',
      filename: '记录.docx',
      adapter: fakeAdapter,
      persistence: persistence.port,
      publish_port: okPublishPort(),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    };
    const created = DeliverableSession.createNew(options, seedSource());
    if (!created.ok) throw new Error('unreachable');
    const session = created.value;
    const base = session.currentDigest();
    await session.publish({
      idempotency_key: 'k',
      base_revision: 0,
      base_digest: base,
      edit: { op: 'append_line', text: '丙' },
    });
    const conflict = await session.publish({
      idempotency_key: 'k',
      base_revision: 1,
      base_digest: session.currentDigest(),
      edit: { op: 'append_line', text: '丁' },
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe('idempotency_conflict');
  });

  it('发布失败：旧源与旧版本一个字节都不变（R145）', async () => {
    const persistence = memoryPersistence();
    const failingPort: DeliverablePublishPort = {
      publish: () =>
        Promise.resolve({
          ok: false as const,
          failure: { kind: 'write_failed', detail: '磁盘满了' },
        }),
    };
    const options = {
      id: 's4',
      deliverable_id: 'd4',
      filename: '记录.docx',
      adapter: fakeAdapter,
      persistence: persistence.port,
      publish_port: failingPort,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    };
    const created = DeliverableSession.createNew(options, seedSource());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const session = created.value;
    const before = session.currentDigest();

    const failed = await session.publish({
      idempotency_key: 'k',
      base_revision: 0,
      base_digest: before,
      edit: { op: 'append_line', text: '不该留下' },
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.code).toBe('publish_failed');
    expect(session.currentRevision(), '失败不得推进版本号').toBe(0);
    expect(session.currentDigest()).toBe(before);
    expect(session.source().lines, '失败不得采纳新源').toEqual(['甲', '乙']);
    expect(session.status().published).toEqual([]);
    expect(session.status().last_failure?.kind).toBe('write_failed');
  });

  it('文件名扩展名与适配器格式不符 ⇒ 构造即拒（R232 互不冒充）', () => {
    const persistence = memoryPersistence();
    const opened = DeliverableSession.createNew(
      {
        id: 's5',
        deliverable_id: 'd5',
        filename: '其实是表格.xlsx',
        adapter: fakeAdapter, // 声明 docx
        persistence: persistence.port,
        publish_port: okPublishPort(),
        now: () => new Date('2026-10-03T00:00:00.000Z'),
      },
      seedSource(),
    );
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.message).toContain('.docx');
  });

  it('恢复时源与落盘摘要分叉 ⇒ 拒绝恢复（不静默采纳）', () => {
    const persistence = memoryPersistence();
    const options = {
      id: 's6',
      deliverable_id: 'd6',
      filename: '记录.docx',
      adapter: fakeAdapter,
      persistence: persistence.port,
      publish_port: okPublishPort(),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    };
    const created = DeliverableSession.createNew(options, seedSource());
    expect(created.ok).toBe(true);
    // 手工改坏落盘摘要（模拟"盘上状态与源分叉"）。
    const saved = persistence.state() as Record<string, unknown>;
    saved['content_digest'] = 'f'.repeat(64);
    const restored = DeliverableSession.restore(options);
    expect(restored.session).toBeNull();
    expect(restored.result.reason).toContain('分叉');
  });

  it('导入：适配器没有导入能力时**明确拒绝**（不给"看起来支持"的入口）', () => {
    const persistence = memoryPersistence();
    const opened = DeliverableSession.importBytes(
      {
        id: 's7',
        deliverable_id: 'd7',
        filename: '记录.docx',
        adapter: fakeAdapter, // 无 importBytes
        persistence: persistence.port,
        publish_port: okPublishPort(),
        now: () => new Date('2026-10-03T00:00:00.000Z'),
      },
      new Uint8Array([1]),
    );
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.code).toBe('unsupported');
  });
});
