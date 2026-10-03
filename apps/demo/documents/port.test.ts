/**
 * 生产物化端口的单测（design-03 P4 / 方案 S5）。
 *
 * 全部用**真实磁盘**（临时目录），不 mock `node:fs`：
 * 端口要证明的正是"盘上确实有这份字节、回读核对过"，用假的文件系统会把被证明的东西换掉。
 *
 * 覆盖：写入与回读一致 / 幂等以回读为准（含"盘上被换过"的负例）/ 入参摘要先于写盘被拒 /
 * 文件名与 artifactId 白名单（含路径穿越）/ readback 的三条分支 / 并发同一 artifact。
 *
 * 这里**不**断言"Word 能打开"（那是第三层证据）。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import {
  DocumentPortError,
  createDocumentPort,
  normalizeDocxFilename,
  sha256Hex,
  type DocumentPort,
} from './port.js';

/** 真实的 DOCX 字节（**不是**随便一段文本：端口服务的正是这类字节）。 */
function docxBytes(title: string, paragraphs: readonly string[]): Uint8Array {
  return buildDocxTemplate({
    requirement: { title, description: '（不使用）', paragraphs },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

const BYTES = docxBytes('新生读书会邀请函', ['欢迎参加本学期的新生读书会。', '带着好奇心来就好。']);
const DIGEST = sha256Hex(BYTES);

const FILENAME = 'invitation.docx';

let root = '';
let port: DocumentPort;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'potbot-docport-'));
  port = createDocumentPort(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function requestOf(overrides: Partial<Parameters<DocumentPort['materialize']>[0]> = {}) {
  return { artifactId: 'art-1', filename: FILENAME, bytes: BYTES, expectedSha256: DIGEST, ...overrides };
}

/** 捕获 DocumentPortError 的 code（失败必须可机器判定，不靠文本匹配）。 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DocumentPortError) return error.code;
    throw error;
  }
  throw new Error('期望抛出 DocumentPortError，但调用成功返回了');
}

// ---------------------------------------------------------------------------
// 1. 写入 → 回读 → 核对
// ---------------------------------------------------------------------------

describe('物化：写盘后必须回读核对', () => {
  it('成功物化：落点在 rootDir 内、字节逐字节相同、摘要与长度来自回读', async () => {
    const receipt = await port.materialize(requestOf());

    expect(receipt.artifactId).toBe('art-1');
    expect(receipt.path).toBe(join(root, 'art-1', FILENAME));
    expect(receipt.byteLength).toBe(BYTES.byteLength);
    expect(receipt.sha256).toBe(DIGEST);

    const onDisk = await readFile(receipt.path);
    expect(Buffer.compare(onDisk, Buffer.from(BYTES))).toBe(0);
    expect(sha256Hex(onDisk)).toBe(DIGEST);
    // 目录里只有这一份交付物（没有临时文件残留）。
    expect(await readdir(join(root, 'art-1'))).toEqual([FILENAME]);
  });

  it('readBack 返回**盘上的真实字节**；未知 artifactId ⇒ undefined', async () => {
    const receipt = await port.materialize(requestOf());
    const readBack = await port.readBack('art-1');
    expect(readBack).toBeDefined();
    expect(Buffer.compare(Buffer.from(readBack ?? new Uint8Array()), Buffer.from(BYTES))).toBe(0);
    expect(sha256Hex(readBack ?? new Uint8Array())).toBe(receipt.sha256);

    expect(await port.readBack('art-404')).toBeUndefined();
  });

  it('中文文件名可接受（白名单按"字母"计，不把中文挡在门外）', async () => {
    const receipt = await port.materialize(requestOf({ filename: '新生读书会邀请函.docx' }));
    expect(receipt.path).toBe(join(root, 'art-1', '新生读书会邀请函.docx'));
    expect(sha256Hex(await readFile(receipt.path))).toBe(DIGEST);
  });
});

// ---------------------------------------------------------------------------
// 2. 幂等：判据是「存在 且 本次回读摘要相符」
// ---------------------------------------------------------------------------

describe('幂等：以磁盘回读为准，memo 不短路', () => {
  it('第二次物化不重写文件（mtime 被钉在过去后仍未变），回执相同', async () => {
    const first = await port.materialize(requestOf());

    const past = new Date(2000, 0, 1, 0, 0, 0);
    await utimes(first.path, past, past);
    const pinned = await stat(first.path);

    const second = await port.materialize(requestOf());
    const after = await stat(first.path);

    expect(second).toEqual(first);
    // 若发生过重写，mtime 会变成"现在"；它仍是 2000 年那份 ⇒ 确实没重写。
    expect(after.mtimeMs).toBe(pinned.mtimeMs);
    expect(sha256Hex(await readFile(first.path))).toBe(DIGEST);
  });

  it('落点已存在但**盘上字节被换过** ⇒ 结构化失败 existing_mismatch，且不覆盖', async () => {
    const receipt = await port.materialize(requestOf());
    const otherBytes = Buffer.from(docxBytes('别的文档', ['这一段完全不同。', '第二段也不同。']));
    await writeFile(receipt.path, otherBytes);

    expect(await codeOf(port.materialize(requestOf()))).toBe('existing_mismatch');
    // 不覆盖：盘上仍是被换过的那一份（"曾经交付过"不等于"现在仍然一致"）。
    expect(sha256Hex(await readFile(receipt.path))).toBe(sha256Hex(otherBytes));
  });

  it('先手工放一份内容不同的文件 ⇒ 同样 existing_mismatch，不覆盖', async () => {
    const directory = join(root, 'art-1');
    await mkdir(directory, { recursive: true });
    const squatter = Buffer.from('这不是我们期望的字节');
    await writeFile(join(directory, FILENAME), squatter);

    expect(await codeOf(port.materialize(requestOf()))).toBe('existing_mismatch');
    expect(Buffer.compare(await readFile(join(directory, FILENAME)), squatter)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 入参校验：摘要不符在写盘之前就拒
// ---------------------------------------------------------------------------

describe('入参校验：摘要不符不落盘', () => {
  it('bytes 与 expectedSha256 不符 ⇒ digest_mismatch，且**一个文件都没写**', async () => {
    const wrong = sha256Hex(Buffer.from('另一个东西'));
    expect(await codeOf(port.materialize(requestOf({ expectedSha256: wrong })))).toBe(
      'digest_mismatch',
    );
    // 目录都没建（写盘前拒绝）。
    await expect(stat(join(root, 'art-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });

  it('empty / 非 Uint8Array 的 bytes ⇒ invalid_bytes', async () => {
    expect(
      await codeOf(port.materialize(requestOf({ bytes: new Uint8Array(0) }))),
    ).toBe('invalid_bytes');
    expect(
      await codeOf(
        port.materialize(requestOf({ bytes: '文字' as unknown as Uint8Array })),
      ),
    ).toBe('invalid_bytes');
  });

  it('expectedSha256 不是 64 位小写 hex ⇒ invalid_expected_sha256（含大小写混用的形态）', async () => {
    expect(
      await codeOf(port.materialize(requestOf({ expectedSha256: DIGEST.toUpperCase() }))),
    ).toBe('invalid_expected_sha256');
    expect(await codeOf(port.materialize(requestOf({ expectedSha256: 'abc' })))).toBe(
      'invalid_expected_sha256',
    );
  });

  it('rootDir 非法 ⇒ 构造期即失败', () => {
    expect(() => createDocumentPort('')).toThrow(DocumentPortError);
    expect(() => createDocumentPort(undefined as unknown as string)).toThrow(/rootDir/);
    expect(() => createDocumentPort('x')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. 白名单：不接受任意路径
// ---------------------------------------------------------------------------

describe('文件名与 artifactId 白名单（路径穿越必须失败）', () => {
  const BAD_FILENAMES: readonly string[] = [
    '../evil.docx',
    '..\\evil.docx',
    'sub/invitation.docx',
    'sub\\invitation.docx',
    '/abs/invitation.docx',
    'C:\\tmp\\invitation.docx',
    '.hidden.docx',
    'noext',
    'invitation.exe',
    'invitation.docx.exe',
    'CON.docx',
    'lpt1.docx',
    'a'.repeat(129) + '.docx',
    'bad\u0000name.docx',
    'bad\nname.docx',
    'invitation.docx.',
  ];

  it.each(BAD_FILENAMES)('拒绝文件名 %j', async (filename) => {
    const code = await codeOf(port.materialize(requestOf({ filename })));
    expect(code).toBe('invalid_filename');
    // 拒绝发生在写盘之前：root 里什么都没有。
    expect(await readdir(root)).toEqual([]);
  });

  const BAD_ARTIFACT_IDS: readonly string[] = [
    '../art',
    'a/b',
    'a\\b',
    '..',
    '.hidden',
    'trailing.',
    'a'.repeat(129),
    '',
  ];

  it.each(BAD_ARTIFACT_IDS)('拒绝 artifactId %j', async (artifactId) => {
    const code = await codeOf(port.materialize(requestOf({ artifactId })));
    expect(code).toBe('invalid_artifact_id');
    expect(await readdir(root)).toEqual([]);
  });

  it('合法的 artifactId 形态（UUID / 带点与横线）照常接受', async () => {
    const receipt = await port.materialize(
      requestOf({ artifactId: 'b1f2c3d4-0000-4aaa-9bbb-artifact-1' }),
    );
    expect(receipt.path).toBe(join(root, 'b1f2c3d4-0000-4aaa-9bbb-artifact-1', FILENAME));
  });
});

// ---------------------------------------------------------------------------
// 5. 文件名规范化
// ---------------------------------------------------------------------------

describe('文件名规范化：把任意标题折成能过白名单的文件名', () => {
  it('中文标题里的空白 / 全角标点折成 -，且规范化结果**必然**落盘成功', async () => {
    const filename = normalizeDocxFilename('新生读书会 邀请函（2026）');
    expect(filename).toBe('新生读书会-邀请函-2026.docx');

    const receipt = await port.materialize(requestOf({ filename }));
    expect(sha256Hex(await readFile(receipt.path))).toBe(DIGEST);
  });

  it('空 / 纯标点标题走 fallback；Windows 保留设备名加前缀', () => {
    expect(normalizeDocxFilename('   ')).toBe('document.docx');
    expect(normalizeDocxFilename('！！！', '未命名')).toBe('未命名.docx');
    expect(normalizeDocxFilename('CON')).toBe('doc-CON.docx');
  });

  it('超长标题截断到 100 码位（含 .docx 共 ≤104 字符，仍在白名单长度内）', () => {
    const filename = normalizeDocxFilename('长'.repeat(300));
    expect([...filename.slice(0, -'.docx'.length)]).toHaveLength(100);
    expect(filename.endsWith('.docx')).toBe(true);
    expect(filename.length).toBeLessThanOrEqual(128);
  });
});

// ---------------------------------------------------------------------------
// 6. readBack 的分支
// ---------------------------------------------------------------------------

describe('readBack：被换过的字节不得发出去', () => {
  it('同一次运行内被篡改 ⇒ readback_digest_mismatch（不返回被换过的字节）', async () => {
    const receipt = await port.materialize(requestOf());
    await writeFile(receipt.path, Buffer.from('篡改过的内容'));

    expect(await codeOf(port.readBack('art-1'))).toBe('readback_digest_mismatch');
  });

  it('进程重启（新端口实例、记忆为空）⇒ 返回盘上字节，**不声称核对过摘要**', async () => {
    const receipt = await port.materialize(requestOf());
    const restarted = createDocumentPort(root);

    const readBack = await restarted.readBack('art-1');
    expect(readBack).toBeDefined();
    expect(sha256Hex(readBack ?? new Uint8Array())).toBe(receipt.sha256);

    // 篡改后重启的端口仍返回盘上字节——摘要核对是调用方的责任（诚实边界，不当成"已核对"）。
    await writeFile(receipt.path, Buffer.from('篡改过的内容'));
    const afterTamper = await restarted.readBack('art-1');
    expect(Buffer.from(afterTamper ?? new Uint8Array()).toString('utf8')).toBe('篡改过的内容');
  });

  it('交付物被删掉 ⇒ readBack 返回 undefined（不拿记忆冒充盘上还有）', async () => {
    const receipt = await port.materialize(requestOf());
    await rm(receipt.path, { force: true });
    expect(await port.readBack('art-1')).toBeUndefined();
  });

  it('目录里有多份 .docx 且记忆为空 ⇒ readback_ambiguous（拒绝猜）', async () => {
    await port.materialize(requestOf());
    await writeFile(join(root, 'art-1', 'another.docx'), Buffer.from('另一份'));
    const restarted = createDocumentPort(root);

    expect(await codeOf(restarted.readBack('art-1'))).toBe('readback_ambiguous');
  });

  it('落点被占成目录（读不动但不是"不存在"）⇒ readback_failed', async () => {
    await mkdir(join(root, 'art-1', FILENAME), { recursive: true });
    expect(await codeOf(port.materialize(requestOf()))).toBe('readback_failed');
  });
});

// ---------------------------------------------------------------------------
// 7. 并发
// ---------------------------------------------------------------------------

describe('并发：同一 artifactId 的物化互相串行，不留半成品', () => {
  it('三个并发请求得到同一回执，盘上仍是期望字节', async () => {
    const receipts = await Promise.all([
      port.materialize(requestOf()),
      port.materialize(requestOf()),
      port.materialize(requestOf()),
    ]);
    const first = receipts[0];
    expect(first).toBeDefined();
    for (const receipt of receipts) expect(receipt).toEqual(first);
    expect(sha256Hex(await readFile(first?.path ?? ''))).toBe(DIGEST);
    // 没有临时文件残留。
    expect(await readdir(join(root, 'art-1'))).toEqual([FILENAME]);
  });
});
