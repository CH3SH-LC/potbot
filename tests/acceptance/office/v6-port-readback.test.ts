/**
 * **V6 — 把「端口必须真的回读最终路径」变成可证伪的判据**（task-id: D02A-WFIX4；合同 v1.4 R49.2 I-1 / R50.3 / R53.7）。
 *
 * ## 为什么需要这一层（V5 的变异实验发现了一条**空断言**）
 *
 * V5 的 M6b 把 `fs-artifact-port.ts` 第 4 步的 `const readbackDigest = sha256Hex(readBack);`
 * 改成 `request.expected_content_digest`（**根本不回读文件**），结果 26 个用例**全绿**。
 * 原因是 J8-I1 的三方对齐 `sha256(落盘) == record.content_digest == receipt.readback_digest`
 * 在"端口写的正是 payload（== 期望字节）"时**恒真**——照抄期望摘要天然满足它。
 * M6c 的对照（改成一个错的字面量）会红一条，说明那条断言**非空洞**，只是**没有对准**
 * "跳过回读"这一形态。
 *
 * ## 本文件的判别构造（**不再依赖 payload 与期望同源**）
 *
 * 1. **期望摘要故意写错**：直接调端口，传**正确的 payload 字节**，但把
 *    `expected_content_digest` 换成一个绝不等于 `sha256(payload)` 的值。
 *    - **真回读的端口**：写盘 → 回读最终路径 → `sha256(回读) ≠ 期望` ⇒ 必然返回
 *      `{ ok: false, kind: 'self_check_failed' }`；
 *    - **照抄期望的端口**：`readbackDigest := 期望` ⇒ 两侧相等 ⇒ 返回 `ok: true`。
 *    于是 `expect(result.ok).toBe(false)` 一旦有人把回读改掉（M6b）**立刻变红**。
 * 2. **单字节篡改**：正常落盘后把 `final_path` 的某一个字节翻转，再对**同一条请求**走
 *    「最终路径已存在 ⇒ 幂等分支」。R50.3 的幂等只在**实际回读摘要与期望相符**时成立；
 *    摘要不符必须暴露——**不得**把被篡改的字节当成"既有成功回执"返回。
 * 3. **摘要一律由字节算出**：`receipt.readback_digest` 必须等于本文件用 `node:crypto`
 *    **独立复算**的 `sha256(实际写到 final_path 的字节)`；不引用被测对象自报的任何摘要值。
 *
 * ## 纪律
 *
 * - 只调**验收侧落盘端口**（`./fs-artifact-port.js`）与纯构建器，不碰内核、不调 `openWithOffice`；
 * - 时间只用**逻辑时间**（`asLogicalTime`），不引入墙钟 / 随机数；
 * - 临时目录落在系统临时目录，清理**带重试**（R53.7：`rmSync` 会 `EBUSY`）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolveHostPath } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  asFactRef,
  asLogicalTime,
  asRevision,
  asTaskId,
  type TaskId,
  type Revision,
  type LogicalTime,
} from '../../../src/protocol/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';
import { planArtifact, type ArtifactPlan } from '../../../src/artifacts/planner.js';
import { buildXlsxTemplate, type XlsxSheetSpec } from '../../../src/artifacts/templates/xlsx.js';
import {
  createFsArtifactMaterializationPort,
  type FsArtifactMaterializationPort,
} from './fs-artifact-port.js';

// ---------------------------------------------------------------------------
// 临时根与带重试清理（R53.7）
// ---------------------------------------------------------------------------

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `potbot-v6-${label}-`));
  roots.push(root);
  return root;
}

/** Office 的 COM 关闭是异步的，刚释放的文件可能仍被占用（`EBUSY`）；重试后仍失败则告警，不判红。 */
afterAll(() => {
  for (const root of roots) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5) {
          console.warn(`[v6] 清理失败（已重试 5 次），按 R53.7 保留目录：${root} — ${String(error)}`);
        } else {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 固定输入（**数字只能来自事实快照**）
// ---------------------------------------------------------------------------

const TASK_ID: TaskId = asTaskId('T1');
const REVISION: Revision = asRevision(1);

function headcountEntry(): KnownFactSnapshotEntry {
  return {
    fact_ref: asFactRef('fact-headcount'),
    fact_key: 'headcount',
    value: { type: 'number', amount: 8, unit: '人', currency: null },
    source: { kind: 'user_confirmation', detail: '用户确认 headcount' },
  };
}

const HEADCOUNT: KnownFactSnapshotEntry = Object.freeze(headcountEntry());

const SHEET_SPEC: XlsxSheetSpec = Object.freeze({
  sheet_name: '人数汇总',
  label_header: '项目',
  value_header: '数量',
  unit: '人',
  lines: Object.freeze([Object.freeze({ label: '参会人数', fact_key: 'headcount' })]),
  total_label: '合计',
  scale: 0,
});

/** 有效 ZIP 字节（合法容器 ⇒ 不会在第 1 层结构自检被拦下）。 */
function payloadBytes(): Buffer {
  return buildXlsxTemplate(SHEET_SPEC, [HEADCOUNT]).bytes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toForwardSlashes(hostPath: string): string {
  return hostPath.split('\\').join('/');
}

function hostPathOf(logicalPath: string): string {
  return resolveHostPath(logicalPath);
}

/** 构造一条请求（`plan` 与 `request` 的 `expected_content_digest` 必须一致，否则端口会先判请求不自洽）。 */
function makeRequest(
  rootDir: string,
  expectedContentDigest: string,
  payload: Uint8Array,
): { readonly plan: ArtifactPlan; readonly request: Parameters<FsArtifactMaterializationPort['materialize']>[0] } {
  const plan = planArtifact({
    task_id: TASK_ID,
    task_revision: REVISION,
    template_kind: 'spreadsheet',
    artifact_version: 1,
    root_dir: toForwardSlashes(rootDir),
    expected_content_digest: expectedContentDigest,
  });
  return {
    plan,
    request: {
      artifact_id: plan.artifact_id,
      task_id: TASK_ID,
      task_revision: REVISION,
      template_kind: 'spreadsheet',
      fact_snapshot: [HEADCOUNT],
      plan,
      expected_content_digest: expectedContentDigest,
      payload,
    },
  };
}

/** 版本闸门读口固定为请求的版本（本文件不测版本闸门）；逻辑时间由调用方给定。 */
function makePort(now: LogicalTime): FsArtifactMaterializationPort {
  return createFsArtifactMaterializationPort({
    read_revision: () => REVISION,
    now: () => now,
  });
}

// ---------------------------------------------------------------------------
// 判据 1：期望摘要被写错 ⇒ 真回读的端口必须 self_check_failed
// ---------------------------------------------------------------------------

describe('V6 端口回读：判据可证伪', () => {
  it('payload 正确但期望摘要故意写错 ⇒ 端口必须 { ok:false, kind:"self_check_failed" }（照抄期望的实现会返回 ok:true）', () => {
    const root = tempRoot('wrong-digest');
    const payload = payloadBytes();
    const realDigest = sha256Hex(payload);
    // 一个绝不等于真实摘要的期望值：全是 0 的 64 位 hex 不可能是这份字节的 sha256。
    const wrongDigest = '0'.repeat(64);
    expect(realDigest, '构造失效：期望摘要与真实摘要意外相等').not.toBe(wrongDigest);

    const { plan } = makeRequest(root, wrongDigest, payload);
    const port = makePort(asLogicalTime(1));
    const result = port.materialize({
      artifact_id: plan.artifact_id,
      task_id: TASK_ID,
      task_revision: REVISION,
      template_kind: 'spreadsheet',
      fact_snapshot: [HEADCOUNT],
      plan,
      expected_content_digest: wrongDigest,
      payload,
    });

    if (result.ok) {
      throw new Error(
        '端口在"期望摘要 ≠ 实际字节摘要"时仍返回了成功回执：' +
          `receipt.readback_digest=${result.receipt.readback_digest}（期望 ${wrongDigest}）、` +
          `payload 的真实 sha256=${realDigest}——“必须回读最终路径”这条判据在此被证伪。`,
      );
    }

    expect(result.failure.kind, `失败种类应为 self_check_failed，detail=${result.failure.detail}`).toBe(
      'self_check_failed',
    );
    // 更强：失败 detail 里必须出现**实际回读到的**摘要（= 本文件独立算出的 sha256(payload)），
    // 证明端口真的对写出的字节取了摘要，而不是复述期望值。
    expect(result.failure.detail, '失败 detail 未携带实际回读摘要').toContain(realDigest);
    expect(result.failure.detail, '失败 detail 未携带期望摘要').toContain(wrongDigest);

    // 失败点必须在"写盘 + 回读"之后：临时路径被写过一次（不是写盘前短路）。
    expect(port.writes, '端口未真正写过临时路径（失败点不在回读阶段）').toBe(1);

    // 最终路径上留着的是 payload 的字节——即"写出的字节正确、只是与期望摘要不符"。
    const finalPath = hostPathOf(plan.final_path);
    expect(existsSync(finalPath), '最终路径不存在（回读应在 rename 之后）').toBe(true);
    const onDiskDigest = sha256Hex(readFileSync(finalPath));
    expect(onDiskDigest, '最终路径上的字节与 payload 不符').toBe(realDigest);

    console.log(
      '[V6-WRONG-EXPECTED-DIGEST]',
      JSON.stringify({
        verdict: 'self_check_failed',
        kind: result.failure.kind,
        expected: wrongDigest,
        readback: realDigest,
        writes: port.writes,
        final_path: plan.final_path,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 判据 2：成功路径上的回读摘要必须由字节算出（独立复算）
  // -------------------------------------------------------------------------

  it('成功路径：receipt.readback_digest === 独立复算的 sha256(实际写到 final_path 的字节)', () => {
    const root = tempRoot('success-readback');
    const payload = payloadBytes();
    const realDigest = sha256Hex(payload);
    const { plan } = makeRequest(root, realDigest, payload);
    const port = makePort(asLogicalTime(1));

    const result = port.materialize({
      artifact_id: plan.artifact_id,
      task_id: TASK_ID,
      task_revision: REVISION,
      template_kind: 'spreadsheet',
      fact_snapshot: [HEADCOUNT],
      plan,
      expected_content_digest: realDigest,
      payload,
    });
    if (!result.ok) {
      throw new Error(`正确载荷 + 正确摘要仍物化失败（${result.failure.kind}）：${result.failure.detail}`);
    }

    const finalPath = hostPathOf(result.receipt.final_path);
    const onDisk = readFileSync(finalPath);
    // 三方对齐，全部由**本文件独立**算出：期望摘要 / 落盘字节 / 回执回读摘要。
    expect(sha256Hex(onDisk), '落盘字节的独立复算摘要 ≠ 期望摘要').toBe(realDigest);
    expect(result.receipt.readback_digest, '回执回读摘要 ≠ 独立复算的落盘摘要').toBe(sha256Hex(onDisk));
    expect(result.receipt.readback_digest, '回执回读摘要 ≠ payload 的真实摘要').toBe(realDigest);
    expect(result.receipt.byte_length, '回执字节长度 ≠ 落盘字节长度').toBe(onDisk.byteLength);
    expect(port.writes, '成功路径应恰好写一次临时路径').toBe(1);

    console.log(
      '[V6-SUCCESS-READBACK]',
      JSON.stringify({
        verdict: 'ok',
        independent_digest: sha256Hex(onDisk),
        receipt_readback_digest: result.receipt.readback_digest,
        byte_length: onDisk.byteLength,
        final_path: result.receipt.final_path,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 判据 3：R50.3 幂等——摘要相符时返回既有回执且不重写；不符时必须暴露
  // -------------------------------------------------------------------------

  it('R50.3：摘要相符 ⇒ 幂等不重写；单字节篡改后摘要不符 ⇒ 不得把被篡改字节当作既有成功回执', () => {
    const root = tempRoot('tamper');
    const payload = payloadBytes();
    const correctDigest = sha256Hex(payload);
    const { plan, request } = makeRequest(root, correctDigest, payload);

    // ① 首次物化：正常落盘。
    const firstPort = makePort(asLogicalTime(1));
    const first = firstPort.materialize(request);
    if (!first.ok) {
      throw new Error(`首次物化失败（${first.failure.kind}）：${first.failure.detail}`);
    }
    const finalPath = hostPathOf(first.receipt.final_path);
    expect(sha256Hex(readFileSync(finalPath)), '首次落盘字节与 payload 不符').toBe(correctDigest);

    // ② 幂等正例：同一请求、最终路径未动、**新端口实例**（无进程内记忆）⇒ 读回摘要相符 ⇒
    //    返回既有回执、**不重写**（writes 不增）。
    const idempotentPort = makePort(asLogicalTime(2));
    const idempotent = idempotentPort.materialize(request);
    if (!idempotent.ok) {
      throw new Error(`幂等重放失败（${idempotent.failure.kind}）：${idempotent.failure.detail}`);
    }
    expect(idempotent.receipt.readback_digest, '幂等回执的回读摘要应与实际落盘摘要一致').toBe(
      correctDigest,
    );
    expect(idempotentPort.writes, 'R50.3：摘要相符时不得重写').toBe(0);

    // ③ 单字节篡改：翻转最终路径中间的一个字节。
    const tampered = Buffer.from(readFileSync(finalPath));
    const index = Math.floor(tampered.length / 2);
    tampered[index] = (tampered[index] ?? 0) ^ 0xff;
    writeFileSync(finalPath, tampered);
    const tamperedDigest = sha256Hex(readFileSync(finalPath));
    expect(tamperedDigest, '构造失效：篡改后摘要未变').not.toBe(correctDigest);

    // ④ 对**同一条请求**再走一次「最终路径已存在 ⇒ 幂等分支」。
    const afterTamperPort = makePort(asLogicalTime(3));
    const again = afterTamperPort.materialize(request);

    if (again.ok) {
      // 若端口声称成功，回执必须描述**当前**最终路径上的实际字节（I-1 在返回这一刻必须成立）——
      // 于是"把篡改前铸下的既有回执原样返回"会当场被抓。
      const onDiskDigest = sha256Hex(readFileSync(finalPath));
      expect(
        onDiskDigest,
        '返回了成功回执，但回执摘要与最终路径上的实际字节不符（疑似返回了篡改前的既有回执）',
      ).toBe(again.receipt.readback_digest);
      expect(again.receipt.readback_digest, '成功回执的回读摘要必须等于正确载荷摘要').toBe(
        correctDigest,
      );
    }

    // ⑤ 摘要不符必须暴露：不得在最终路径仍是被篡改字节的情况下返回成功。
    const settledDigest = sha256Hex(readFileSync(finalPath));
    expect(
      again.ok && settledDigest === tamperedDigest,
      '端口把摘要不符的（被篡改的）字节当成了既有成功回执：R50.3 的幂等只在摘要相符时成立',
    ).toBe(false);

    console.log(
      '[V6-TAMPER-IDEMPOTENCY]',
      JSON.stringify({
        verdict: again.ok ? 're-materialized' : 'rejected',
        correct_digest: correctDigest,
        tampered_digest: tamperedDigest,
        settled_digest: settledDigest,
        idempotent_writes: idempotentPort.writes,
        after_tamper_writes: afterTamperPort.writes,
        after_tamper_ok: again.ok,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 判据 4–6（W-FIX7 新增）：**同一端口实例**上的幂等分支不得靠进程内记忆短路
// ---------------------------------------------------------------------------
//
// 上面判据 3 的 ② 用的是**新端口实例**（无进程内记忆）⇒ 必然走"回读磁盘"那一支，
// 因此它对 `#existingDeliveryOf()` 开头那条 memo 短路（"本实例曾经交付过"）**无感**。
// W-FIX4 的临时探针实测：同一实例上 memo 命中时根本不回读磁盘，篡改最终路径后仍返回
// `{"second_ok":true,"stale":true}`（回执摘要 ≠ 盘上字节）。下面三条把那个缺口钉死：
//
//   A 篡改后走**同一实例**的幂等分支 ⇒ 必须结构化失败（修之前：返回 stale 成功 ⇒ 红）
//   B 删除后走同一实例的幂等分支 ⇒ 不得退回既有回执（语义选择见用例内注释）
//   C 对照：未篡改时同一实例两次 ⇒ 幂等仍然成立（成功且不重写）

describe('W-FIX7：同一端口实例的幂等分支必须回读磁盘（memo 不得短路校验）', () => {
  it('W-FIX7-A 篡改 1 字节后走同一实例的幂等分支 ⇒ { ok:false, kind:"self_check_failed" }（memo 短路实现在此红）', () => {
    const root = tempRoot('memo-tamper');
    const payload = payloadBytes();
    const correctDigest = sha256Hex(payload);
    const { plan, request } = makeRequest(root, correctDigest, payload);

    // ① 首次物化：正常落盘，并在**同一个实例**上留下 memo 回执。
    const port = makePort(asLogicalTime(1));
    const first = port.materialize(request);
    if (!first.ok) {
      throw new Error(`首次物化失败（${first.failure.kind}）：${first.failure.detail}`);
    }
    const finalPath = hostPathOf(first.receipt.final_path);
    expect(port.writes, '首次物化应恰好写一次').toBe(1);
    expect(
      port.receiptOf(plan.artifact_id),
      '前置失效：首次物化后本实例没有留下回执 ⇒ 下面走的不是 memo 分支，判据落空',
    ).toBeDefined();

    // ② 篡改最终路径上的一个字节。
    const tampered = Buffer.from(readFileSync(finalPath));
    const index = Math.floor(tampered.length / 2);
    tampered[index] = (tampered[index] ?? 0) ^ 0xff;
    writeFileSync(finalPath, tampered);
    const tamperedDigest = sha256Hex(readFileSync(finalPath));
    expect(tamperedDigest, '构造失效：篡改后摘要未变').not.toBe(correctDigest);

    // ③ **同一个端口实例**、**同一条请求**，再走一次「最终路径已存在 ⇒ 幂等分支」。
    const writesBefore = port.writes;
    const second = port.materialize(request);

    if (second.ok) {
      const staleNote =
        second.receipt.readback_digest === correctDigest
          ? '回执沿用了篡改前铸下的摘要'
          : '回执摘要与期望摘要不符';
      throw new Error(
        '同一实例的幂等分支在最终路径已被篡改时仍返回成功回执：' +
          `${staleNote}（receipt.readback_digest=${second.receipt.readback_digest}），` +
          `而盘上实际 sha256=${tamperedDigest}——“回读摘要与期望一致才幂等”（R50.3）被证伪。`,
      );
    }

    expect(
      second.failure.kind,
      `失败种类应为 self_check_failed，detail=${second.failure.detail}`,
    ).toBe('self_check_failed');
    // detail 必须写明**本次实际回读到的**摘要与期望摘要两边的值（证明真的回读并算了摘要）。
    expect(second.failure.detail, '失败 detail 未携带实际回读摘要').toContain(tamperedDigest);
    expect(second.failure.detail, '失败 detail 未携带期望摘要').toContain(correctDigest);
    // 拒绝时不得动盘：被篡改的字节仍在原处（不做静默覆盖，也不留下临时文件残留）。
    expect(sha256Hex(readFileSync(finalPath)), '拒绝路径不得改写最终路径').toBe(tamperedDigest);
    expect(port.writes, '拒绝路径不得写盘').toBe(writesBefore);

    console.log(
      '[W-FIX7-MEMO-TAMPER]',
      JSON.stringify({
        verdict: 'self_check_failed',
        same_instance: true,
        expected_digest: correctDigest,
        tampered_digest: tamperedDigest,
        detail_kind: second.failure.kind,
        writes_after: port.writes,
        settled_digest: sha256Hex(readFileSync(finalPath)),
      }),
    );
  });

  it('W-FIX7-B 删除最终路径后走同一实例的幂等分支 ⇒ 不得退回既有回执，必须真的重新产出', () => {
    const root = tempRoot('memo-deleted');
    const payload = payloadBytes();
    const correctDigest = sha256Hex(payload);
    const { plan, request } = makeRequest(root, correctDigest, payload);

    const port = makePort(asLogicalTime(1));
    const first = port.materialize(request);
    if (!first.ok) {
      throw new Error(`首次物化失败（${first.failure.kind}）：${first.failure.detail}`);
    }
    const finalPath = hostPathOf(first.receipt.final_path);
    expect(port.receiptOf(plan.artifact_id)).toBeDefined();

    // ② 把最终路径删掉（文件消失）。
    rmSync(finalPath, { force: true });
    expect(existsSync(finalPath), '构造失效：最终路径未被删掉').toBe(false);

    // ③ 同一实例、同一条请求再走一次。
    const second = port.materialize(request);

    // 语义选择（R49.1 第 2 段 / R49.4 的重放）：最终路径**不存在** ⇒ R50.3 的幂等前提
    // （"已存在且回读摘要与期望一致"）不成立 ⇒ 交回物化管线**重新产出**；不得把 memo 里的
    // "曾经交付过"当成"现在已交付"退回去（那正是 A 要消灭的同型错误）。
    //
    // 本用例因此断言 **重新物化**（而不是结构化失败）：R49.4 明确 `staged` 记录可被重跑、
    // "临时文件丢失且最终路径不存在"要能补回来；若在此硬失败，被删除的产物将永远无法再交付。
    if (!second.ok) {
      throw new Error(
        `删除后重新物化失败（${second.failure.kind}）：${second.failure.detail}——` +
          '最终路径不存在时幂等前提不成立，应走重建管线（R49.1 第 2 段）。',
      );
    }
    // 回执必须描述**现在盘上的文件**（I-1 在返回这一刻成立）：文件回到盘上、字节与期望一致、
    // 回执摘要与独立复算的盘上摘要一致——三条都断言，杜绝"退回一个 stale 成功"。
    expect(existsSync(finalPath), '重新物化后最终路径必须回来').toBe(true);
    const onDiskDigest = sha256Hex(readFileSync(finalPath));
    expect(onDiskDigest, '重新产出的字节与期望摘要不符').toBe(correctDigest);
    expect(second.receipt.readback_digest, '回执回读摘要 ≠ 独立复算的盘上摘要').toBe(onDiskDigest);
    expect(second.receipt.readback_digest, '回执回读摘要 ≠ 期望摘要').toBe(correctDigest);
    expect(second.receipt.byte_length, '回执字节长度 ≠ 盘上字节长度').toBe(
      readFileSync(finalPath).byteLength,
    );
    expect(port.writes, '删除后必须真的重写一次（退回 memo 会让 writes 不增）').toBe(2);

    console.log(
      '[W-FIX7-MEMO-DELETED]',
      JSON.stringify({
        verdict: 're-materialized',
        same_instance: true,
        expected_digest: correctDigest,
        on_disk_digest: onDiskDigest,
        writes_after: port.writes,
      }),
    );
  });

  it('W-FIX7-C 对照：未篡改时同一实例两次 ⇒ 第二次 ok===true 且 writes 不增（幂等仍然成立）', () => {
    const root = tempRoot('memo-contrast');
    const payload = payloadBytes();
    const correctDigest = sha256Hex(payload);
    const { plan, request } = makeRequest(root, correctDigest, payload);

    const port = makePort(asLogicalTime(1));
    const first = port.materialize(request);
    if (!first.ok) {
      throw new Error(`首次物化失败（${first.failure.kind}）：${first.failure.detail}`);
    }
    const finalPath = hostPathOf(first.receipt.final_path);
    expect(port.writes, '首次物化应恰好写一次').toBe(1);

    // 同一实例、同一条请求、盘上未动 ⇒ 幂等必须仍然成立：成功 + **不重写**。
    const second = port.materialize(request);
    if (!second.ok) {
      throw new Error(`未篡改的幂等重放失败（${second.failure.kind}）：${second.failure.detail}`);
    }
    const onDisk = readFileSync(finalPath);
    expect(second.receipt.readback_digest, '幂等回执的回读摘要 ≠ 独立复算的盘上摘要').toBe(
      sha256Hex(onDisk),
    );
    expect(second.receipt.readback_digest, '幂等回执的回读摘要 ≠ 期望摘要').toBe(correctDigest);
    expect(second.receipt.byte_length, '幂等回执的字节长度 ≠ 盘上字节长度').toBe(onDisk.byteLength);
    expect(second.receipt.final_path, '幂等回执的最终路径必须与计划一致').toBe(plan.final_path);
    expect(port.writes, 'R50.3：摘要相符时不得重写').toBe(1);
    // 回执仍然记得住：`receiptOf` 必须能交出同一条产物 id 的回执。
    expect(port.receiptOf(plan.artifact_id), '幂等路径应保留回执可查').toBeDefined();

    console.log(
      '[W-FIX7-MEMO-CONTRAST]',
      JSON.stringify({
        verdict: 'ok',
        same_instance: true,
        independent_digest: sha256Hex(onDisk),
        receipt_readback_digest: second.receipt.readback_digest,
        writes_after: port.writes,
      }),
    );
  });
});
