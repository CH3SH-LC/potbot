/**
 * **J8 — 确定性产物：逐字节可复现**（design-02 A 批；合同 v1.4 R51.6 / R52.2 / R53）。
 *
 * ## 这一层判什么（**四件事，缺一不可**）
 *
 * 1. **逐字节可复现**：同一输入构造两次 ⇒ 容器字节逐字节相等、sha256 相等（三类各一对）。
 * 2. **跨进程**：在**子 `node` 进程**里对**已落盘**的同一份产物算 sha256，与主进程一致。
 *    —— 刻意**不**在子进程里 import 被测 TS：源码用 `.js` 说明符，Node 原生剥离不解析 `.js → .ts`，
 *    所以核对的是**落盘字节**，而不是"再次运行同一段 JS"。
 * 3. **ZIP 结构不随运行变化**：中央目录里 STORE（方法 0）/ DOS 时间 `0x0000` / 日期 `0x0021` /
 *    通用位标志 0 / 无 extra（本地头同样无 extra）。口径与 `v1-ooxml-templates.test.ts` 一致，
 *    但**解析器是本文件自己的实现**（不照抄它的断言）。
 * 4. **产物可读回**：`readback(path).ok === true`，且
 *    `sha256(落盘字节) == 记录的 content_digest == receipt.readback_digest`。
 *    这是 I-1 的**端到端形式**——证明"端口真的逐字节回读"。
 *
 * ## 为什么第 4 条必须经物化端口
 *
 * 只比"两次构建的字节相同"证明不了 I-1：I-1 说的是 `published` 记录的回执摘要**来自对最终路径的
 * 实际回读**。因此这里让字节真正落盘（`FsArtifactMaterializationPort`），再拿回执里的
 * `readback_digest` 与实际落盘字节的摘要三方对齐。
 *
 * ## 纪律
 *
 * - 时间/顺序无关：只用**逻辑时间**与**固定事实快照**，不引入墙钟、随机数或环境变量。
 * - 产物落在系统临时目录，清理带重试（R53.7 的纪律同样适用）。
 * - 三个验证仪器只 import，不修改。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolveHostPath } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  asFactRef,
  asLogicalTime,
  asRevision,
  asTaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';
import { planArtifact } from '../../../src/artifacts/planner.js';
import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { buildXlsxTemplate, type XlsxSheetSpec } from '../../../src/artifacts/templates/xlsx.js';
import { buildPresentation } from '../../../src/artifacts/templates/pptx.js';
import { createFsArtifactMaterializationPort } from './fs-artifact-port.js';
import { readbackArtifact } from './independent-readback.js';
import { requireToolchain } from './toolchain.js';

// ---------------------------------------------------------------------------
// 临时根与带重试清理（R53.7）
// ---------------------------------------------------------------------------

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `potbot-repro-${label}-`));
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
          console.warn(`[repro] 清理失败（已重试 5 次），按 R53.7 保留目录：${root} — ${String(error)}`);
        } else {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 固定事实快照（**单一来源**：所有数字只能从这里来）
// ---------------------------------------------------------------------------

function numberEntry(
  ref: string,
  key: string,
  amount: number,
  unit: string,
  currency: string | null,
): KnownFactSnapshotEntry {
  return {
    fact_ref: asFactRef(ref),
    fact_key: key,
    value: { type: 'number', amount, unit, currency },
    source: { kind: 'user_confirmation', detail: `用户确认 ${key}` },
  };
}

function dateEntry(ref: string, key: string, iso: string): KnownFactSnapshotEntry {
  return {
    fact_ref: asFactRef(ref),
    fact_key: key,
    value: { type: 'date', iso_date: iso, time_zone: 'Asia/Shanghai' },
    source: { kind: 'document', detail: `${key} 来自活动资料` },
  };
}

const HEADCOUNT = numberEntry('fact-headcount', 'headcount', 8, '人', null);
const BUDGET = numberEntry('fact-budget', 'budget.total', 600, '元', 'CNY');
const EVENT_DATE = dateEntry('fact-date', 'event.date', '2026-10-02');
const VENUE = numberEntry('fact-venue', 'cost.venue', 1200, '元', 'CNY');
const FOOD = numberEntry('fact-food', 'cost.food', 300, '元', 'CNY');

/** 表格规格：两行明细 + 合计（合计 = 1500，可被 Excel 读回核对）。 */
const SHEET_SPEC: XlsxSheetSpec = Object.freeze({
  sheet_name: '预算',
  label_header: '项目',
  value_header: '金额',
  unit: '元',
  lines: Object.freeze([
    Object.freeze({ label: '场地', fact_key: 'cost.venue' }),
    Object.freeze({ label: '餐饮', fact_key: 'cost.food' }),
  ]),
  total_label: '合计',
  scale: 0,
});

// ---------------------------------------------------------------------------
// 三类的构造（**同一输入连跑两次**的输入源）
// ---------------------------------------------------------------------------

interface BuiltKind {
  readonly kind: TemplateKind;
  readonly extension: string;
  readonly bytes: Buffer;
  readonly content_digest: string;
  readonly entry_count: number;
  /** 该产物消费的事实快照（I-1 端到端请求要原样带上）。 */
  readonly fact_snapshot: readonly KnownFactSnapshotEntry[];
}

/**
 * 构造某一类的产物。**每次调用都从零构造**——正是"同一输入构造两次"里的那一次，
 * 因此调用方连续调用两次即可判定可复现性。
 */
function buildKind(kind: TemplateKind): BuiltKind {
  switch (kind) {
    case 'document': {
      const fact_snapshot = [HEADCOUNT, EVENT_DATE];
      const built = buildDocxTemplate({
        requirement: {
          title: '聚餐安排',
          description: '本文件只陈述已确认事实，不改写人数、金额与日期。',
        },
        fact_snapshot,
        references: [{ label: '用户确认', detail: '人数与日期由用户在前台确认' }],
      });
      return Object.freeze({
        kind,
        extension: 'docx',
        bytes: built.bytes,
        content_digest: built.content_digest,
        entry_count: built.entry_count,
        fact_snapshot: Object.freeze([...fact_snapshot]),
      });
    }
    case 'spreadsheet': {
      const fact_snapshot = [VENUE, FOOD];
      const built = buildXlsxTemplate(SHEET_SPEC, fact_snapshot);
      return Object.freeze({
        kind,
        extension: 'xlsx',
        bytes: built.bytes,
        content_digest: built.content_digest,
        entry_count: built.entry_count,
        fact_snapshot: Object.freeze([...fact_snapshot]),
      });
    }
    case 'presentation': {
      const fact_snapshot = [HEADCOUNT, BUDGET, EVENT_DATE];
      const built = buildPresentation({
        title: '聚餐安排',
        goal: '确认聚餐的人数与预算',
        audience: '筹备组成员',
        fact_snapshot,
      });
      return Object.freeze({
        kind,
        extension: 'pptx',
        bytes: built.bytes,
        content_digest: built.content_digest,
        entry_count: built.entry_count,
        fact_snapshot: Object.freeze([...fact_snapshot]),
      });
    }
    default: {
      const unexpected: never = kind;
      throw new Error(`未登记的模板种类：${String(unexpected)}`);
    }
  }
}

const KINDS: readonly TemplateKind[] = Object.freeze(['document', 'spreadsheet', 'presentation']);

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hostPathOf(logicalPath: string): string {
  return resolveHostPath(logicalPath);
}

function toForwardSlashes(hostPath: string): string {
  return hostPath.split('\\').join('/');
}

// ---------------------------------------------------------------------------
// 自有的 ZIP 中央目录解析器（**不照抄 v1 测试**）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

interface CentralEntry {
  readonly name: string;
  readonly version_made_by: number;
  readonly version_needed: number;
  readonly flags: number;
  readonly method: number;
  readonly dos_time: number;
  readonly dos_date: number;
  readonly crc32: number;
  readonly compressed_size: number;
  readonly uncompressed_size: number;
  readonly extra_length: number;
  readonly comment_length: number;
  readonly local_header_offset: number;
}

interface ZipStructure {
  readonly entry_count: number;
  readonly disk_entry_count: number;
  readonly central_directory_size: number;
  readonly entries: readonly CentralEntry[];
}

/** 从尾部向前找 EOCD（无注释，所以尾部 22 字节即可；仍向前扫以抗注释）。 */
function findEndOfCentralDirectory(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= 0 && offset >= bytes.length - 65_557; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP 尾部找不到 EOCD 记录（不是合法 ZIP 容器）');
}

/** 解析中央目录，并顺带核对每个条目的**本地头**（flags / extra 两处都要为常量）。 */
function readZipStructure(bytes: Buffer): ZipStructure {
  const eocd = findEndOfCentralDirectory(bytes);
  const diskEntryCount = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  let cursor = bytes.readUInt32LE(eocd + 16);

  const entries: CentralEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${index} 条不是 PK\\x01\\x02 签名（偏移 ${cursor}）`);
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const dosTime = bytes.readUInt16LE(cursor + 12);
    const dosDate = bytes.readUInt16LE(cursor + 14);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    // 本地头：同一份常量必须成立（否则"中央目录看着对、实际解压另有 extra"）
    if (bytes.readUInt32LE(localHeaderOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`条目 ${name} 的本地头不是 PK\\x03\\x04 签名`);
    }
    const localFlags = bytes.readUInt16LE(localHeaderOffset + 6);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    if (localFlags !== flags) {
      throw new Error(`条目 ${name} 的本地头 flags（${localFlags}）与中央目录（${flags}）不一致`);
    }
    if (localExtraLength !== 0) {
      throw new Error(`条目 ${name} 的本地头含 extra 字段（长度 ${localExtraLength}）`);
    }

    entries.push(
      Object.freeze({
        name,
        version_made_by: versionMadeBy,
        version_needed: versionNeeded,
        flags,
        method,
        dos_time: dosTime,
        dos_date: dosDate,
        crc32,
        compressed_size: compressedSize,
        uncompressed_size: uncompressedSize,
        extra_length: extraLength,
        comment_length: commentLength,
        local_header_offset: localHeaderOffset,
      }),
    );
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (cursor - bytes.readUInt32LE(eocd + 16) !== centralSize) {
    throw new Error('中央目录实际长度与 EOCD 自报的 central_directory_size 不一致');
  }

  return Object.freeze({
    entry_count: entryCount,
    disk_entry_count: diskEntryCount,
    central_directory_size: centralSize,
    entries: Object.freeze(entries),
  });
}

// ---------------------------------------------------------------------------
// J8 判据
// ---------------------------------------------------------------------------

describe('J8 确定性产物：逐字节可复现（R51.6）', () => {
  it('三类产物各构造两次 ⇒ 容器字节逐字节相等、sha256 相等', () => {
    for (const kind of KINDS) {
      const first = buildKind(kind);
      const second = buildKind(kind);

      expect(
        first.bytes.equals(second.bytes),
        `${kind}：两次构造的字节不逐字节相等（长度 ${first.bytes.byteLength} vs ${second.bytes.byteLength}）`,
      ).toBe(true);
      expect(second.bytes.byteLength).toBe(first.bytes.byteLength);
      expect(second.content_digest, `${kind}：两次构造的 sha256 不相等`).toBe(first.content_digest);
      expect(first.content_digest).toBe(sha256Hex(first.bytes));
      expect(second.content_digest).toBe(sha256Hex(second.bytes));

      console.log(
        '[J8-BYTES]',
        JSON.stringify({
          kind,
          byte_length: first.bytes.byteLength,
          entry_count: first.entry_count,
          content_digest: first.content_digest,
        }),
      );
    }
  });

  it('跨进程：子 node 进程对已落盘字节算出的 sha256 与主进程一致', () => {
    const root = tempRoot('cross');
    // 子进程只做一件事：读**落盘字节**、算 sha256、写到 stdout。
    // 刻意不 import 被测 TS —— 源码用 `.js` 说明符，Node 原生剥离不解析 `.js → .ts`。
    const hasher =
      "const c=require('node:crypto'),f=require('node:fs');" +
      'process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"));';

    for (const kind of KINDS) {
      const built = buildKind(kind);
      const filePath = join(root, `${kind}.${built.extension}`);
      writeFileSync(filePath, built.bytes);

      const childDigest = execFileSync(process.execPath, ['-e', hasher, filePath], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      }).trim();

      const parentDigest = sha256Hex(readFileSync(filePath));
      expect(childDigest, `${kind}：子进程与主进程的 sha256 不一致`).toBe(parentDigest);
      expect(childDigest).toBe(built.content_digest);

      console.log(
        '[J8-CROSS-PROCESS]',
        JSON.stringify({ kind, child: childDigest, parent: parentDigest, path: filePath }),
      );
    }
  });

  it('ZIP 结构不随运行变化：STORE / 时间 0x0000 / 日期 0x0021 / flags 0 / 无 extra', () => {
    for (const kind of KINDS) {
      const first = buildKind(kind);
      const second = buildKind(kind);
      const firstZip = readZipStructure(Buffer.from(first.bytes));
      const secondZip = readZipStructure(Buffer.from(second.bytes));

      expect(firstZip.entry_count, `${kind}：条目数应等于构建器自报的 entry_count`).toBe(
        first.entry_count,
      );
      expect(firstZip.disk_entry_count, `${kind}：单盘 ZIP 的 disk 条目数应等于总条目数`).toBe(
        firstZip.entry_count,
      );
      expect(firstZip.entry_count).toBeGreaterThan(0);

      for (const entry of firstZip.entries) {
        const where = `${kind}:${entry.name}`;
        expect(entry.method, `${where} 压缩方法应为 0（STORE）`).toBe(0);
        expect(entry.dos_time, `${where} DOS 时间应为 0x0000`).toBe(0x0000);
        expect(entry.dos_date, `${where} DOS 日期应为 0x0021`).toBe(0x0021);
        expect(entry.flags, `${where} 通用位标志应为 0`).toBe(0);
        expect(entry.extra_length, `${where} 中央目录不应有 extra 字段`).toBe(0);
        expect(entry.comment_length, `${where} 不应有文件注释`).toBe(0);
        expect(entry.compressed_size, `${where} STORE 下压缩大小应等于原始大小`).toBe(
          entry.uncompressed_size,
        );
      }

      // 结构本身不随运行变化：条目序列（名 + 全部常量字段 + CRC + 大小）逐条可比。
      const structural = (zip: ZipStructure): readonly string[] =>
        zip.entries.map((entry) =>
          [
            entry.name,
            entry.version_made_by,
            entry.version_needed,
            entry.flags,
            entry.method,
            entry.dos_time,
            entry.dos_date,
            entry.crc32,
            entry.compressed_size,
            entry.uncompressed_size,
            entry.extra_length,
            entry.comment_length,
          ].join('|'),
        );
      expect(structural(secondZip), `${kind}：两次运行的 ZIP 结构不一致`).toEqual(
        structural(firstZip),
      );

      console.log(
        '[J8-ZIP-STRUCTURE]',
        JSON.stringify({
          kind,
          entry_count: firstZip.entry_count,
          entries: firstZip.entries.map((entry) => entry.name),
        }),
      );
    }
  });

  it('产物可读回：readback.ok 且 sha256(落盘) == 记录 content_digest == receipt.readback_digest（I-1 端到端）', () => {
    const tools = requireToolchain();
    const root = tempRoot('i1');
    const planRoot = toForwardSlashes(root);
    const taskId = asTaskId('T1');
    const revision = asRevision(1);

    // 版本闸门读口：固定返回请求里的任务版本（本用例只验 I-1，不验版本闸门）。
    const port = createFsArtifactMaterializationPort({
      read_revision: () => revision,
      now: () => asLogicalTime(1),
    });

    for (const kind of KINDS) {
      const built = buildKind(kind);
      const plan = planArtifact({
        task_id: taskId,
        task_revision: revision,
        template_kind: kind,
        artifact_version: 1,
        root_dir: planRoot,
        expected_content_digest: built.content_digest,
      });

      const result = port.materialize({
        artifact_id: plan.artifact_id,
        task_id: taskId,
        task_revision: revision,
        template_kind: kind,
        fact_snapshot: built.fact_snapshot,
        plan,
        expected_content_digest: built.content_digest,
        payload: built.bytes,
      });

      if (!result.ok) {
        throw new Error(
          `${kind}：物化失败（${result.failure.kind}）：${result.failure.detail}`,
        );
      }
      const receipt = result.receipt;
      const finalPath = hostPathOf(receipt.final_path);
      const onDisk = readFileSync(finalPath);
      const onDiskDigest = sha256Hex(onDisk);

      // I-1 的三方对齐：落盘字节 == 记录的内容摘要 == 回执的回读摘要。
      expect(onDiskDigest, `${kind}：落盘字节与构建器 content_digest 不符`).toBe(
        built.content_digest,
      );
      expect(receipt.readback_digest, `${kind}：回执 readback_digest 与 content_digest 不符`).toBe(
        built.content_digest,
      );
      expect(receipt.byte_length, `${kind}：回执字节长度与实际不符`).toBe(onDisk.byteLength);
      expect(receipt.entry_count, `${kind}：回执条目数与构建器不符`).toBe(built.entry_count);
      expect(onDisk.byteLength).toBe(built.bytes.byteLength);

      // 第二层独立读回（Python zipfile + xml.etree、unzip -t）。
      const readback = readbackArtifact(tools, finalPath);
      expect(readback.bad_entry, `${kind}：独立读回报出坏条目`).toBeNull();
      expect(readback.xml_problems, `${kind}：独立读回有 XML 解析问题`).toEqual([]);
      expect(readback.unzip_test.exit_code, `${kind}：unzip -t 退出码非 0`).toBe(0);
      expect(readback.ok, `${kind}：独立读回 ok 不为 true`).toBe(true);

      console.log(
        '[J8-I1-READBACK]',
        JSON.stringify({
          kind,
          verdict: 'ok',
          on_disk_digest: onDiskDigest,
          record_content_digest: built.content_digest,
          receipt_readback_digest: receipt.readback_digest,
          byte_length: onDisk.byteLength,
          entry_count: receipt.entry_count,
          readback_entries: readback.entries.map((entry) => entry.name),
          python: `${readback.python.via} → ${readback.python.executable} (${readback.python.version})`,
          unzip: `${readback.unzip.via} → ${readback.unzip.executable}`,
        }),
      );
    }
  });
});
