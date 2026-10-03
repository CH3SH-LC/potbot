/**
 * F06 验收：预览容器（P1–P5）——「预览由业务插件返回」但必须绑到确切字节。
 *
 * 反向对照（判据必须真能咬）：
 *   1) 无字节的版本**不得**进入 ready，附加预览被 `preview-not-available` 挡住；
 *   2) 预览描述的 `sourceDigest` 与那一版字节摘要不等（含把旧版摘要贴到新版）—— `preview-bytes-mismatch`；
 *   3) 跨文件 / 版本号不符 —— `cross-file-revision` / `preview-revision-mismatch`；
 *   4) 未附加描述时取描述抛 `preview-not-attached`，而不是返回 null 让调用方猜。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  attachPreview,
  canPreview,
  createFile,
  hasPreview,
  initialPreviewContainer,
  noBytes,
  previewOf,
  previewProducedBy,
  withBytes,
} from '../../../apps/mobile-ui/src/files/index.js';

const T = (n: number) => `2026-10-03T00:0${n}:00Z`;

function digestFor(ch: string): string {
  return `sha256:${ch.repeat(64)}`;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

/** 一个带字节的 word 文件，digest 由 `ch` 决定。 */
function byteFile(ch = 'a', fileId = 'f-1') {
  return createFile({
    fileId,
    kind: 'word',
    title: '季度方案',
    createdAt: T(0),
    bytes: withBytes(2048, digestFor(ch)),
  });
}

const GOOD_DESCRIPTOR = {
  producer: 'word-plugin',
  mime: 'application/vnd.potbot.word-preview+json',
  renderParts: ['document', 'styles'],
};

describe('F06 / P1 无字节不得承载预览', () => {
  it('草稿版本的容器是 unavailable，且不能预览', () => {
    const draft = createFile({ fileId: 'f-d', kind: 'word', title: '草稿', createdAt: T(0) });
    const container = initialPreviewContainer(draft, 1);
    expect(container.state).toBe('unavailable');
    expect(container.descriptor).toBeNull();
    expect(canPreview(draft, 1)).toBe(false);
  });

  it('反向对照：向 unavailable 容器附加预览 → preview-not-available', () => {
    const draft = createFile({ fileId: 'f-d', kind: 'word', title: '草稿', createdAt: T(0) });
    const container = initialPreviewContainer(draft, 1);
    expect(
      codeOf(() =>
        attachPreview(draft, container, { ...GOOD_DESCRIPTOR, sourceDigest: digestFor('a') }),
      ),
    ).toBe('preview-not-available');
  });

  it('目标版本不在链上 → unknown-revision', () => {
    const file = byteFile();
    expect(codeOf(() => initialPreviewContainer(file, 9))).toBe('unknown-revision');
    expect(codeOf(() => initialPreviewContainer(file, 0))).toBe('unknown-revision');
  });
});

describe('F06 / P2 预览必须绑定到确切字节摘要', () => {
  it('摘要一致才接受，且描述被冻结', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    expect(ready.state).toBe('ready');
    expect(hasPreview(ready)).toBe(false);

    const attached = attachPreview(file, ready, {
      ...GOOD_DESCRIPTOR,
      sourceDigest: digestFor('a'),
    });
    expect(hasPreview(attached)).toBe(true);
    const descriptor = previewOf(attached);
    expect(descriptor.fileId).toBe('f-1');
    expect(descriptor.revision).toBe(1);
    expect(descriptor.sourceDigest).toBe(digestFor('a'));
    expect(descriptor.renderParts).toEqual(['document', 'styles']);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(previewProducedBy(attached, 'word-plugin')).toBe(true);
    expect(previewProducedBy(attached, 'excel-plugin')).toBe(false);
  });

  it('反向对照：摘要不符 / 非摘要形状 → preview-bytes-mismatch', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    expect(
      codeOf(() => attachPreview(file, ready, { ...GOOD_DESCRIPTOR, sourceDigest: digestFor('b') })),
    ).toBe('preview-bytes-mismatch');
    expect(
      codeOf(() => attachPreview(file, ready, { ...GOOD_DESCRIPTOR, sourceDigest: 'deadbeef' })),
    ).toBe('preview-bytes-mismatch');
  });

  it('反向对照：把旧版摘要贴到新版容器 → preview-bytes-mismatch（过期预览不得复用到新内容）', () => {
    const withA = byteFile('a');
    const next = appendRevision(withA, {
      expectedRevision: 1,
      createdAt: T(1),
      bytes: withBytes(4096, digestFor('c')),
    });
    const readyFor2 = initialPreviewContainer(next, 2);
    expect(
      codeOf(() =>
        attachPreview(next, readyFor2, { ...GOOD_DESCRIPTOR, sourceDigest: digestFor('a') }),
      ),
    ).toBe('preview-bytes-mismatch');
    // 用第 2 版自己的摘要才通过。
    const ok = attachPreview(next, readyFor2, { ...GOOD_DESCRIPTOR, sourceDigest: digestFor('c') });
    expect(previewOf(ok).revision).toBe(2);
  });
});

describe('F06 / P3 预览归属同文件 / 同版本', () => {
  it('描述 fileId 与文件不符 → cross-file-revision', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    expect(
      codeOf(() =>
        attachPreview(file, ready, {
          ...GOOD_DESCRIPTOR,
          fileId: 'f-other',
          sourceDigest: digestFor('a'),
        }),
      ),
    ).toBe('cross-file-revision');
  });

  it('描述 revision 与容器不符 → preview-revision-mismatch', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    expect(
      codeOf(() =>
        attachPreview(file, ready, {
          ...GOOD_DESCRIPTOR,
          revision: 2,
          sourceDigest: digestFor('a'),
        }),
      ),
    ).toBe('preview-revision-mismatch');
  });
});

describe('F06 / P4 描述形状校验', () => {
  it('producer / mime / renderParts 形状非法 → invalid-preview-descriptor', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const base = { sourceDigest: digestFor('a') };
    expect(codeOf(() => attachPreview(file, ready, { ...base, ...GOOD_DESCRIPTOR, producer: '  ' }))).toBe(
      'invalid-preview-descriptor',
    );
    expect(codeOf(() => attachPreview(file, ready, { ...base, ...GOOD_DESCRIPTOR, mime: 'not-a-mime' }))).toBe(
      'invalid-preview-descriptor',
    );
    expect(
      codeOf(() =>
        attachPreview(file, ready, {
          ...base,
          ...GOOD_DESCRIPTOR,
          renderParts: ['a', 'a'] as string[],
        }),
      ),
    ).toBe('invalid-preview-descriptor');
    expect(
      codeOf(() =>
        attachPreview(file, ready, {
          ...base,
          ...GOOD_DESCRIPTOR,
          renderParts: 'document' as unknown as string[],
        }),
      ),
    ).toBe('invalid-preview-descriptor');
    expect(
      codeOf(() =>
        attachPreview(file, ready, { ...base, ...GOOD_DESCRIPTOR, renderParts: [''] as string[] }),
      ),
    ).toBe('invalid-preview-descriptor');
  });

  it('renderParts 允许为空数组（插件可能只返回结构信息）', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    const attached = attachPreview(file, ready, {
      producer: 'excel-plugin',
      mime: 'application/json',
      sourceDigest: digestFor('a'),
      renderParts: [],
    });
    expect(previewOf(attached).renderParts).toEqual([]);
  });
});

describe('F06 / P5 未附加不得被当成可渲染', () => {
  it('ready 但未附加描述 → previewOf 抛 preview-not-attached', () => {
    const file = byteFile('a');
    const ready = initialPreviewContainer(file, 1);
    expect(codeOf(() => previewOf(ready))).toBe('preview-not-attached');
  });

  it('unavailable 容器取描述同样抛 preview-not-attached', () => {
    const draft = createFile({ fileId: 'f-d', kind: 'ppt', title: '草稿', createdAt: T(0) });
    const container = initialPreviewContainer(draft, 1);
    expect(codeOf(() => previewOf(container))).toBe('preview-not-attached');
  });

  it('版本带字节回退成无字节后，新容器不再 ready（当前版看的是字节本身）', () => {
    const withBytes1 = byteFile('a');
    const backToDraft = appendRevision(withBytes1, {
      expectedRevision: 1,
      createdAt: T(1),
      bytes: noBytes(),
    });
    expect(canPreview(backToDraft, 1)).toBe(true); // 第 1 版仍有自己的字节
    expect(canPreview(backToDraft, 2)).toBe(false); // 第 2 版没有字节
    expect(initialPreviewContainer(backToDraft, 2).state).toBe('unavailable');
  });
});
