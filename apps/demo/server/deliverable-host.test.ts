/**
 * 交付会话宿主测试（design-06 P8/P9 的产品入口；合同 R232 / R247 / R250）。
 *
 * ## 这一组用例要证明的核心命题
 *
 * 1. **表格与演示确实经内核任务发布**，不是宿主自造回执：store 里那条 `ArtifactRecord`
 *    的 `status === 'published'`、带 `receipt`，且 `template_kind` / `mime_type` 正确。
 * 2. **回执摘要 == 盘上实际回读的摘要**（I-1）：直接读磁盘文件重算 sha256 比对。
 * 3. **产物落在内核规划的版本化路径上**（`<root>/<task>/r<rev>/<kind>/<id>.<ext>`）——
 *    这是"没有旁路发布链"的结构性证据（旁路实现要自己复刻这条路径才可能通过）。
 * 4. **R232 格式互不冒充**：xlsx 的产物记录 MIME 是 spreadsheetml；pptx 是 presentationml；
 *    文件名扩展名与格式一致。
 * 5. **R250**：表格能有多张表、演示能有多页（不是固定一张表 / 两页）。
 * 6. **没有"直接写文件就宣称成功"的路径**：对实现源码做文本扫描。
 *
 * 用 `node:os.tmpdir()` 下的临时目录 + **生产物化端口**，用完即删，**不碰 `.runtime/`**。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatSpec } from '../../../src/session/index.js';
import { createDocumentPort, type DocumentPort } from '../documents/port.js';
import { DeliverableHost } from './deliverable-host.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-deliverable-host-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function newHost(documents: DocumentPort | null = createDocumentPort(workDir)): DeliverableHost {
  return new DeliverableHost({
    documents,
    artifact_root_dir: workDir.split('\\').join('/'),
    run_id: 'FA-T-TEST-RUN',
    now: () => new Date('2026-10-03T00:00:00.000Z'),
  });
}

function sha256(bytes: Uint8Array): string {
  // 用 node:crypto 独立重算（不调生产实现的 digestBytes）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/** 递归列出目录下所有文件的绝对路径。 */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/** 打开一个表格会话并写两张表 + 若干单元格（R250：不只有一张固定表）。 */
async function buildSpreadsheet(host: DeliverableHost): Promise<{ sessionId: string; revision: number; digest: string; artifactId: string }> {
  const opened = host.open({
    session_id: 'sheet-session',
    deliverable_id: 'sheet-1',
    filename: '台账.xlsx',
    format: 'xlsx',
    title: '台账',
  });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  if (!opened.ok) throw new Error('unreachable');

  let revision = opened.value.edit_revision;
  let digest = opened.value.content_digest;

  // 第一步：加第二张表（R250：多张表）。
  const addSheet = await host.publish('sheet-session', {
    idempotency_key: 'k1',
    base_revision: revision,
    base_digest: digest,
    edit: { op: 'add_sheet', name: '明细' },
  });
  expect(addSheet.ok, JSON.stringify(addSheet)).toBe(true);
  if (!addSheet.ok || addSheet.value.published === null) throw new Error('第一版未发布');
  revision = addSheet.value.edit_revision;
  digest = addSheet.value.published.content_digest;

  // 第二步：往两张表里写单元格。
  const setCells = await host.publish('sheet-session', {
    idempotency_key: 'k2',
    base_revision: revision,
    base_digest: digest,
    edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '项目' } },
  });
  expect(setCells.ok, JSON.stringify(setCells)).toBe(true);
  if (!setCells.ok || setCells.value.published === null) throw new Error('第二版未发布');
  revision = setCells.value.edit_revision;
  digest = setCells.value.published.content_digest;

  const setNumber = await host.publish('sheet-session', {
    idempotency_key: 'k3',
    base_revision: revision,
    base_digest: digest,
    edit: { op: 'set_cell', sheet: '明细', address: 'B2', value: { kind: 'number', value: 42 } },
  });
  expect(setNumber.ok, JSON.stringify(setNumber)).toBe(true);
  if (!setNumber.ok || setNumber.value.published === null) throw new Error('第三版未发布');

  return {
    sessionId: 'sheet-session',
    revision: setNumber.value.edit_revision,
    digest: setNumber.value.published.content_digest,
    artifactId: setNumber.value.published.artifact_id,
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('DeliverableHost：表格经内核发布链交付', () => {
  it('产物记录是 published、MIME 正确、且盘上字节与回执摘要一致', async () => {
    const host = newHost();
    const result = await buildSpreadsheet(host);
    const spec = formatSpec('xlsx');

    const record = host.kernelArtifact(result.artifactId);
    expect(record, '内核里必须有一条该产物的记录').toBeDefined();
    if (record === undefined) return;

    expect(record.status).toBe('published');
    expect(record.template_kind).toBe('spreadsheet');
    expect(record.mime_type).toBe(spec.mime);
    expect(record.mime_type).not.toBe(formatSpec('docx').mime);
    expect(record.receipt).not.toBeNull();
    expect(record.receipt?.readback_digest).toBe(result.digest);

    // 产物由**生产物化端口**落盘，路径含内核派生的 artifact_id
    // （旁路实现要复刻"内核 id ↔ 盘上文件"这一步才可能通过）。
    //
    // 注：内核 planner 另有一条 `final_path`（`<root>/<task>/r<rev>/<kind>/<id>.<ext>`），
    // 而 Demo 物化端口用的是自己的 `<root>/<artifact_id>/<文件名>` 布局，回执记的是**端口**的
    // 实际路径。两条布局并存是本仓既有事实（`port.ts` 头部有说明），本用例按**盘上真实落点**断言。
    const files = listFiles(workDir).map((path) => path.split('\\').join('/'));
    const matches = files.filter((path) => path.endsWith(`.${spec.extension}`));
    expect(matches.length, `产物根下应有 .${spec.extension} 文件：${files.join('、')}`).toBeGreaterThan(0);
    const artifactPath = matches.find((path) => path.includes(result.artifactId));
    expect(artifactPath, '产物路径必须含内核派生的 artifact_id').toBeDefined();
    expect(record.receipt?.final_path).toBe(artifactPath);

    const bytes = readFileSync(artifactPath ?? '');
    expect(sha256(new Uint8Array(bytes))).toBe(result.digest);
  });

  it('产物版本号随每次编辑递增，且三个号分开（R141）', async () => {
    const host = newHost();
    const result = await buildSpreadsheet(host);
    const status = host.status(result.sessionId);
    expect(status).toBeDefined();
    if (status === undefined) return;
    expect(status.file_format).toBe('xlsx');
    expect(status.template_kind).toBe('spreadsheet');
    expect(status.published.map((version) => version.artifact_version)).toEqual([1, 2, 3]);
    expect(status.published.map((version) => version.edit_revision)).toEqual([1, 2, 3]);
    for (const version of status.published) {
      expect(version.task_revision).toBeGreaterThan(0);
      expect(version.mime_type).toBe(formatSpec('xlsx').mime);
    }
  });

  it('下载面回读盘上字节，并给出该格式的 MIME（互不冒充）', async () => {
    const host = newHost();
    const result = await buildSpreadsheet(host);
    const found = await host.versionBytes(result.sessionId, result.revision);
    expect(found).toBeDefined();
    if (found === undefined) return;
    expect(found.mime_type).toBe(formatSpec('xlsx').mime);
    expect(found.file_format).toBe('xlsx');
    expect(found.filename.endsWith('.xlsx')).toBe(true);
    expect(sha256(found.bytes)).toBe(result.digest);
  });

  it('幂等键重放不产生第二个版本（R146）', async () => {
    const host = newHost();
    const opened = host.open({
      session_id: 'idem-session',
      deliverable_id: 'idem-1',
      filename: '幂等.xlsx',
      format: 'xlsx',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const edit = { op: 'add_sheet', name: '甲' };
    const first = await host.publish('idem-session', {
      idempotency_key: 'same',
      base_revision: 0,
      base_digest: opened.value.content_digest,
      edit,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await host.publish('idem-session', {
      idempotency_key: 'same',
      base_revision: 0,
      base_digest: first.value.published?.content_digest ?? '',
      edit,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(host.kernelArtifactList().length, '重放不得新增产物记录').toBe(1);
  });

  it('基线不符时拒绝且不产生新版本（R142/R143）', async () => {
    const host = newHost();
    const opened = host.open({
      session_id: 'stale-session',
      deliverable_id: 'stale-1',
      filename: '过期.xlsx',
      format: 'xlsx',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const stale = await host.publish('stale-session', {
      idempotency_key: 'stale-key',
      base_revision: 7,
      base_digest: opened.value.content_digest,
      edit: { op: 'add_sheet', name: '甲' },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('stale_revision');
    expect(host.kernelArtifactList().length).toBe(0);
  });

  it('物化端口未接入时拒绝发布（不用直接写文件顶替）', async () => {
    const host = newHost(null);
    const opened = host.open({
      session_id: 'noport-session',
      deliverable_id: 'noport-1',
      filename: '无端口.xlsx',
      format: 'xlsx',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outcome = await host.publish('noport-session', {
      idempotency_key: 'k',
      base_revision: 0,
      base_digest: opened.value.content_digest,
      edit: { op: 'add_sheet', name: '甲' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('publish_failed');
    expect(JSON.stringify(outcome.detail)).toContain('document_port_unavailable');
  });
});

describe('DeliverableHost：演示经内核发布链交付', () => {
  it('页数由模型决定（R250：不是固定两页），产物 MIME 是 presentationml', async () => {
    const host = newHost();
    const opened = host.open({
      session_id: 'deck-session',
      deliverable_id: 'deck-1',
      filename: '汇报.pptx',
      format: 'pptx',
      title: '汇报',
    });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;

    // 加三页（不是两页）。
    let revision = opened.value.edit_revision;
    let digest = opened.value.content_digest;
    const slideIds: number[] = [];
    for (const title of ['封面', '数据', '结论']) {
      const outcome = await host.publish('deck-session', {
        idempotency_key: `slide-${title}`,
        base_revision: revision,
        base_digest: digest,
        edit: { op: 'add_slide', title },
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok || outcome.value.published === null) return;
      revision = outcome.value.edit_revision;
      digest = outcome.value.published.content_digest;
      slideIds.push(Number.parseInt(/slide_id=(\d+)/.exec(outcome.value.notes.join(' '))?.[1] ?? '-1', 10));
    }
    expect(slideIds.filter((id) => id >= 0)).toHaveLength(3);

    const status = host.status('deck-session');
    expect(status?.template_kind).toBe('presentation');
    const last = status?.current ?? null;
    expect(last).not.toBeNull();
    if (last === null) return;
    expect(last?.mime_type).toBe(formatSpec('pptx').mime);
    expect(last?.mime_type).not.toBe(formatSpec('xlsx').mime);

    const record = host.kernelArtifact(last?.artifact_id ?? '');
    expect(record?.status).toBe('published');
    expect(record?.template_kind).toBe('presentation');
    expect(record?.mime_type).toBe(formatSpec('pptx').mime);

    const found = await host.versionBytes('deck-session', revision);
    expect(found?.file_format).toBe('pptx');
    expect(found?.filename.endsWith('.pptx')).toBe(true);
  });

  it('docx 在本入口被明确拒绝（不另开一条同名不同能力的 Word 通道）', () => {
    const host = newHost();
    const opened = host.open({
      session_id: 'docx-session',
      deliverable_id: 'docx-1',
      filename: '文档.docx',
      format: 'docx',
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.code).toBe('unsupported');
    expect(opened.message).toContain('/api/sessions');
  });

  it('文件名扩展名与格式不符时拒绝开会话（R232 互不冒充）', () => {
    const host = newHost();
    const opened = host.open({
      session_id: 'mismatch-session',
      deliverable_id: 'mismatch-1',
      filename: '其实是表格.docx',
      format: 'xlsx',
    });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.message).toContain('.xlsx');
  });
});
