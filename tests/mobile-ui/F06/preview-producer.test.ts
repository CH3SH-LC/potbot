/**
 * F06 集成验收：预览容器**消费业务插件产出的 PreviewDescriptor**（P1–P5 仍须咬住）。
 *
 * 业务方 W/X/P 实现 {@link PreviewProducer}；F06 只把插件描述交给既有 `attachPreview`
 * 做同一套绑定校验，不解析内容、不读字节。本文件的反向对照确保「fail-closed」真的成立：
 *   - 插件抛错 / reject / 返回非对象 / producer 与端口不符 → 一律不出预览；
 *   - 插件回显旧版摘要 → preview-bytes-mismatch（过期预览不得贴到新内容）；
 *   - 描述跨文件 / 跨版本 → cross-file-revision / preview-revision-mismatch；
 *   - 无字节容器 / 已取消 → 根本**不调用**插件（用调用计数证明）。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  attachPluginPreview,
  createFile,
  hasPreview,
  initialPreviewContainer,
  previewOf,
  withBytes,
  type PreviewDescriptor,
  type PreviewProducer,
} from '../../../apps/mobile-ui/src/files/index.js';

const T = (n: number) => `2026-10-03T00:0${n}:00Z`;

function digestFor(ch: string): string {
  return `sha256:${ch.repeat(64)}`;
}

/** 一个带字节的 word 文件（digest 由 ch 决定）。 */
function byteFile(ch = 'a', fileId = 'f-1') {
  return createFile({
    fileId,
    kind: 'word',
    title: '季度方案',
    createdAt: T(0),
    bytes: withBytes(2048, digestFor(ch)),
  });
}

/** 记录调用次数的插件包装。 */
function countingPlugin(
  producer: string,
  produce: PreviewProducer['produce'],
): { plugin: PreviewProducer; calls: () => number } {
  let calls = 0;
  return {
    plugin: {
      producer,
      produce: (input) => {
        calls += 1;
        return produce(input);
      },
    },
    calls: () => calls,
  };
}

function goodDescriptor(overrides: Partial<PreviewDescriptor> = {}): PreviewDescriptor {
  return {
    fileId: 'f-1',
    revision: 1,
    producer: 'word-plugin',
    mime: 'application/vnd.potbot.word-preview+json',
    sourceDigest: digestFor('a'),
    renderParts: ['document', 'styles'],
    ...overrides,
  };
}

describe('F06 / 业务插件产出预览（正路）', () => {
  it('同步插件回显输入摘要 → 容器附加描述', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const { plugin, calls } = countingPlugin('word-plugin', (input) =>
      goodDescriptor({ sourceDigest: input.digest, revision: input.revision, fileId: input.fileId }),
    );

    const attached = await attachPluginPreview(file, ready, plugin);
    expect(calls()).toBe(1);
    expect(hasPreview(attached)).toBe(true);
    const descriptor = previewOf(attached);
    expect(descriptor.producer).toBe('word-plugin');
    expect(descriptor.revision).toBe(1);
    expect(descriptor.sourceDigest).toBe(digestFor('a'));
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it('异步插件同样被受理（插件可先渲染再返回）', async () => {
    const file = byteFile('c');
    const ready = initialPreviewContainer(file, 1);
    const plugin: PreviewProducer = {
      producer: 'excel-plugin',
      produce: async (input) => ({
        fileId: input.fileId,
        revision: input.revision,
        producer: 'excel-plugin',
        mime: 'application/json',
        sourceDigest: input.digest,
        renderParts: ['sheet'],
      }),
    };
    const attached = await attachPluginPreview(file, ready, plugin);
    expect(previewOf(attached).producer).toBe('excel-plugin');
  });

  it('新版有字节时插件拿到的是**那一版**的摘要', async () => {
    const v1 = byteFile('a');
    const v2 = appendRevision(v1, {
      expectedRevision: 1,
      createdAt: T(1),
      bytes: withBytes(4096, digestFor('c')),
    });
    const ready = initialPreviewContainer(v2, 2);
    const plugin: PreviewProducer = {
      producer: 'word-plugin',
      produce: (input) => {
        expect(input.revision).toBe(2);
        expect(input.byteLength).toBe(4096);
        return goodDescriptor({ fileId: input.fileId, revision: input.revision, sourceDigest: input.digest });
      },
    };
    const attached = await attachPluginPreview(v2, ready, plugin);
    expect(previewOf(attached).sourceDigest).toBe(digestFor('c'));
  });
});

describe('F06 / 业务插件 fail-closed（反向对照）', () => {
  it('插件抛错 → invalid-preview-descriptor，不出预览', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const plugin: PreviewProducer = {
      producer: 'word-plugin',
      produce: () => {
        throw new Error('renderer crashed at LOCAL-MARKER-A');
      },
    };
    await expect(attachPluginPreview(file, ready, plugin)).rejects.toMatchObject({
      code: 'invalid-preview-descriptor',
    });
    await expect(attachPluginPreview(file, ready, plugin)).rejects.not.toThrow(/LOCAL-MARKER-A/);
  });

  it('插件 reject / 返回非对象 → invalid-preview-descriptor', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const rejecting: PreviewProducer = {
      producer: 'word-plugin',
      produce: () => Promise.reject(new Error('boom')),
    };
    await expect(attachPluginPreview(file, ready, rejecting)).rejects.toMatchObject({
      code: 'invalid-preview-descriptor',
    });
    const nonObject: PreviewProducer = {
      producer: 'word-plugin',
      produce: () => 'nope' as unknown as PreviewDescriptor,
    };
    await expect(attachPluginPreview(file, ready, nonObject)).rejects.toMatchObject({
      code: 'invalid-preview-descriptor',
    });
  });

  it('插件返回的 producer 与端口注册引用不一致 → invalid-preview-descriptor', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const { plugin } = countingPlugin('word-plugin', () => goodDescriptor({ producer: 'evil-plugin' }));
    await expect(attachPluginPreview(file, ready, plugin)).rejects.toMatchObject({
      code: 'invalid-preview-descriptor',
    });
  });

  it('端口 producer 引用本身非法（空白）→ invalid-preview-descriptor 且不调用插件', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const { plugin, calls } = countingPlugin('   ', () => goodDescriptor());
    await expect(attachPluginPreview(file, ready, plugin)).rejects.toMatchObject({
      code: 'invalid-preview-descriptor',
    });
    expect(calls()).toBe(0);
  });

  it('插件回显旧版摘要 → preview-bytes-mismatch（过期预览不得贴到新内容）', async () => {
    const v1 = byteFile('a');
    const v2 = appendRevision(v1, {
      expectedRevision: 1,
      createdAt: T(1),
      bytes: withBytes(4096, digestFor('c')),
    });
    const ready = initialPreviewContainer(v2, 2);
    const plugin: PreviewProducer = {
      producer: 'word-plugin',
      // 把第 1 版的旧摘要贴到第 2 版
      produce: () => goodDescriptor({ fileId: 'f-1', revision: 2, sourceDigest: digestFor('a') }),
    };
    await expect(attachPluginPreview(v2, ready, plugin)).rejects.toMatchObject({
      code: 'preview-bytes-mismatch',
    });
  });

  it('插件描述跨文件 / 跨版本 → cross-file-revision / preview-revision-mismatch', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const crossFile: PreviewProducer = {
      producer: 'word-plugin',
      produce: () => goodDescriptor({ fileId: 'f-other' }),
    };
    await expect(attachPluginPreview(file, ready, crossFile)).rejects.toMatchObject({
      code: 'cross-file-revision',
    });
    const crossRevision: PreviewProducer = {
      producer: 'word-plugin',
      produce: () => goodDescriptor({ revision: 2 }),
    };
    await expect(attachPluginPreview(file, ready, crossRevision)).rejects.toMatchObject({
      code: 'preview-revision-mismatch',
    });
  });
});

describe('F06 / 未就绪与取消：不调用插件', () => {
  it('无字节容器 → preview-not-available，插件不被调用', async () => {
    const draft = createFile({ fileId: 'f-d', kind: 'word', title: '草稿', createdAt: T(0) });
    const container = initialPreviewContainer(draft, 1);
    const { plugin, calls } = countingPlugin('word-plugin', () => goodDescriptor({ fileId: 'f-d' }));
    await expect(attachPluginPreview(draft, container, plugin)).rejects.toMatchObject({
      code: 'preview-not-available',
    });
    expect(calls()).toBe(0);
  });

  it('已取消信号 → preview-not-attached，插件不被调用', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const { plugin, calls } = countingPlugin('word-plugin', () => goodDescriptor());
    await expect(
      attachPluginPreview(file, ready, plugin, { signal: { aborted: true } }),
    ).rejects.toMatchObject({ code: 'preview-not-attached' });
    expect(calls()).toBe(0);
  });

  it('容器版本不在链上 → unknown-revision（不静默降级）', async () => {
    const file = byteFile('a');
    const forged = { state: 'ready', revision: 9, descriptor: null } as const;
    const { plugin, calls } = countingPlugin('word-plugin', () => goodDescriptor({ revision: 9 }));
    await expect(attachPluginPreview(file, forged, plugin)).rejects.toMatchObject({
      code: 'unknown-revision',
    });
    expect(calls()).toBe(0);
  });
});

describe('F06 / 错误对象不泄露插件原始报文', () => {
  it('插件抛错映射后的 details 只保留错误类型，不带原文', async () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const plugin: PreviewProducer = {
      producer: 'word-plugin',
      produce: () => {
        throw new Error('raw producer payload LOCAL-MARKER-B');
      },
    };
    try {
      await attachPluginPreview(file, ready, plugin);
      throw new Error('期望抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(FileError);
      const serialized = JSON.stringify((error as FileError).details ?? {});
      expect(serialized).not.toContain('LOCAL-MARKER-B');
      expect(serialized).toContain('Error');
    }
  });
});
