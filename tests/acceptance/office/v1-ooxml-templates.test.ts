/**
 * **独立验收 V1（task-id D02A-V1）** —— 从外部证伪 OOXML 容器核心与三类模板构建器。
 *
 * 本文件是**新增**的验收测试，只 import 被测对象与两个验证仪器
 * （`./toolchain.js`、`./independent-readback.js`），**不修改** `src/**` 与既有测试/仪器。
 * 不调用 `openWithOffice`（Office COM 另有专职包），只覆盖 R53 的**第 1/2 层**：
 * 结构自检 + 独立读回（Python `zipfile` / `unzip -t`）。
 *
 * 八条独立判据，每条都写成**可证伪**的断言（负例与控制组一并给出）：
 * 1. 零新增依赖 + `src/**`（非测试）无 `node:fs` / `node:zlib` / `node:child_process`；
 * 2. 确定性 ZIP：重复写逐字节相等；中央目录常量（STORE / 时间 0x0000 / 日期 0x0021 /
 *    标志 0 / 无 extra）；Python 独立解析 `testzip() === None` 且 `unzip -t` 退出码 0；
 * 3. golden 摘要**自己重算**（W-A / W-D1 / W-D2 / W-D3 的写死常量），不等即阻断；
 * 4. 属性顺序真的进了字节（只换属性顺序 ⇒ 字节不同）；
 * 5. XML 无 BOM、声明一致、换行固定 `\n`（三类产物全部 XML 部件）；
 * 6. 模板边界可证伪（DOCX 拒凭空数字 / XLSX 缺失不当零 vs 已知零 / PPTX 数字可指认）；
 * 7. 跨调用可复现（同输入构造两次 ⇒ sha256 相等）；
 * 8. 结构自检与 Python 回读的条目数 / 关键文本交叉核对。
 *
 * 纪律：本文件只新增、不改被测对象；断言红了就写进报告，**不为了让断言变绿而放宽判据**。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { asFactRef, type KnownFactValue } from '../../../src/protocol/index.js';
import type { KnownFactSnapshotEntry } from '../../../src/artifacts/ports.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  XML_DECLARATION,
  assembleOpcPackage,
  attr,
  crc32,
  el,
  serializeXmlDocument,
  writeZip,
} from '../../../src/artifacts/ooxml/index.js';
import { buildDocxTemplate, untraceableDigitRuns } from '../../../src/artifacts/templates/docx.js';
import { buildXlsxSheetXml, buildXlsxTemplate } from '../../../src/artifacts/templates/xlsx.js';
import type { XlsxFactEntry, XlsxSheetSpec } from '../../../src/artifacts/templates/xlsx.js';
import { buildPresentation, renderFactLine } from '../../../src/artifacts/templates/pptx.js';
import { readbackArtifact } from './independent-readback.js';
import { requireToolchain } from './toolchain.js';

// ---------------------------------------------------------------------------
// 仓库路径与临时目录（验收侧允许 node:fs —— 合同 R50.4 唯一豁免位置就是本目录）
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const tempRoots: string[] = [];

/** 建一处临时根（惰性、进程内复用；产物只落系统临时目录，不入仓库）。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'potbot-v1-'));
  tempRoots.push(root);
  return root;
}

/** 清理带重试（合同 R53.7 的纪律：清理失败只告警，不把一个通过的用例判红）。 */
afterAll(() => {
  for (const root of tempRoots) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) console.warn(`[D02A-V1] 清理失败，保留取证：${root} — ${String(error)}`);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  }
});

/** 把产物写入临时目录并返回绝对路径（独立读回需要真实文件）。 */
function writeTemp(name: string, bytes: Uint8Array): string {
  const path = join(tempRoot(), name);
  writeFileSync(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------
// 夹具（逐字镜像各单测写死 golden 时所用的输入；不复用其断言）
// ---------------------------------------------------------------------------

function fact(
  key: string,
  value: KnownFactValue,
  detail = '用户在前台确认',
): KnownFactSnapshotEntry {
  return {
    fact_ref: asFactRef(`fact-${key}`),
    fact_key: key,
    value,
    source: { kind: 'user_confirmation', detail },
  };
}

// —— W-D1（DOCX）golden 输入 ——
const DOCX_SNAPSHOT: readonly KnownFactSnapshotEntry[] = [
  fact('headcount', { type: 'number', amount: 8, unit: '人', currency: null }),
  fact('budget.total', { type: 'number', amount: 600, unit: 'CNY', currency: 'CNY' }),
  fact('event.date', { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' }),
  fact('venue', { type: 'text', text: '图书馆三楼会议室', source: '场地确认单' }),
];

function buildDocx() {
  return buildDocxTemplate({
    requirement: { title: '季度总结会安排', description: '根据已确认事实整理，供组内传阅。' },
    fact_snapshot: DOCX_SNAPSHOT,
    references: [{ label: '场地确认单', detail: '由行政组提供' }],
  });
}

// —— W-D2（XLSX）golden 输入 ——
const XLSX_SPEC: XlsxSheetSpec = {
  sheet_name: '预算',
  label_header: '项目',
  value_header: '金额',
  unit: '元',
  lines: [
    { label: '餐饮', fact_key: 'budget.food' },
    { label: '交通', fact_key: 'budget.transport' },
    { label: '住宿', fact_key: 'budget.lodging' },
  ],
  total_label: '合计',
  scale: 2,
};

function xlsxFact(key: string, amount: number, unit = '元'): XlsxFactEntry {
  return {
    fact_ref: asFactRef(`fact-${key}`),
    fact_key: key,
    value: { type: 'number', amount, unit, currency: null },
    source: { kind: 'user_confirmation', detail: '前台确认' },
  };
}

function xlsxBaseFacts(): XlsxFactEntry[] {
  return [xlsxFact('budget.food', 1200), xlsxFact('budget.transport', 300), xlsxFact('budget.lodging', 450.5)];
}

function buildXlsx() {
  return buildXlsxTemplate(XLSX_SPEC, xlsxBaseFacts());
}

// —— W-D3（PPTX）golden 输入 ——
const HEADCOUNT: KnownFactSnapshotEntry = fact('headcount', {
  type: 'number',
  amount: 10,
  unit: '人',
  currency: null,
});
const BUDGET: KnownFactSnapshotEntry = fact('budget.total', {
  type: 'number',
  amount: 12800,
  unit: '元',
  currency: 'CNY',
});
const EVENT_DATE: KnownFactSnapshotEntry = {
  fact_ref: asFactRef('fact-date'),
  fact_key: 'event.date',
  value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
  source: { kind: 'document', detail: '由已授权资料得出' },
};
const VENUE: KnownFactSnapshotEntry = {
  fact_ref: asFactRef('fact-venue'),
  fact_key: 'venue.name',
  value: { type: 'text', text: '上海交通大学闵行校区', source: '已授权资料' },
  source: { kind: 'document', detail: '由已授权资料得出' },
};
const PPTX_SNAPSHOT: readonly KnownFactSnapshotEntry[] = [HEADCOUNT, BUDGET, EVENT_DATE, VENUE];

function buildPptx(snapshot: readonly KnownFactSnapshotEntry[] = PPTX_SNAPSHOT) {
  return buildPresentation({
    title: '年会筹备方案',
    goal: '向管理层说明筹备进展与资源需求',
    audience: '公司管理层',
    fact_snapshot: snapshot,
  });
}

// ---------------------------------------------------------------------------
// 独立 ZIP 解析（本文件自带，不借用被测对象的读侧；只按 ZIP 规范读字节）
// ---------------------------------------------------------------------------

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface LocalEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly extraLength: number;
  readonly versionNeeded: number;
}

interface CentralEntry {
  readonly name: string;
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly extraLength: number;
  readonly commentLength: number;
  readonly internalAttributes: number;
  readonly externalAttributes: number;
  readonly localHeaderOffset: number;
}

function findEocdOffset(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  throw new Error('ZIP 里找不到 EOCD（结束记录）');
}

/** 从偏移 0 起顺序走本地文件头（顺带验证条目首尾相接、无间隙）。 */
function readLocalEntries(bytes: Buffer): LocalEntry[] {
  const entries: LocalEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === LOCAL_SIG) {
    const versionNeeded = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const dosTime = bytes.readUInt16LE(offset + 10);
    const dosDate = bytes.readUInt16LE(offset + 12);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.push({
      name,
      data: bytes.subarray(dataStart, dataStart + size),
      flags,
      method,
      dosTime,
      dosDate,
      extraLength,
      versionNeeded,
    });
    offset = dataStart + size;
  }
  return entries;
}

function readCentralEntries(bytes: Buffer): CentralEntry[] {
  const eocdOffset = findEocdOffset(bytes);
  const count = bytes.readUInt16LE(eocdOffset + 10);
  const cdOffset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: CentralEntry[] = [];
  let cursor = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`第 ${index} 条中央目录项签名不对（offset=${cursor}）`);
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    entries.push({
      name: bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      versionMadeBy: bytes.readUInt16LE(cursor + 4),
      versionNeeded: bytes.readUInt16LE(cursor + 6),
      flags: bytes.readUInt16LE(cursor + 8),
      method: bytes.readUInt16LE(cursor + 10),
      dosTime: bytes.readUInt16LE(cursor + 12),
      dosDate: bytes.readUInt16LE(cursor + 14),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize: bytes.readUInt32LE(cursor + 24),
      extraLength,
      commentLength,
      internalAttributes: bytes.readUInt16LE(cursor + 36),
      externalAttributes: bytes.readUInt32LE(cursor + 38),
      localHeaderOffset: bytes.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 取某部件的原始字节（全 STORE ⇒ 本地头数据区就是文件原始字节）。 */
function partBytesOf(bytes: Buffer, path: string): Buffer {
  const entry = readLocalEntries(bytes).find((candidate) => candidate.name === path);
  if (entry === undefined) throw new Error(`容器里没有部件：${path}`);
  return entry.data;
}

function xmlPartsOf(bytes: Buffer): readonly { readonly name: string; readonly text: string }[] {
  return readLocalEntries(bytes)
    .filter((entry) => entry.name.endsWith('.xml') || entry.name.endsWith('.rels'))
    .map((entry) => ({ name: entry.name, text: entry.data.toString('utf8') }));
}

/** 用 Python 的 `hashlib` 独立算文件 sha256（与被测对象的 node:crypto 路径完全不同的实现）。 */
function pythonSha256(pythonExecutable: string, filePath: string): string {
  const script =
    'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())';
  const stdout = execFileSync(pythonExecutable, ['-c', script, filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsHide: true,
  });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// 判据 1：零新增依赖 + src 无非豁免 IO
// ---------------------------------------------------------------------------

function walkSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walkSourceFiles(full));
    else if (name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** 只匹配**真实的 import/require 语句**（注释里出现 `` `node:fs` `` 不算）。 */
const FORBIDDEN_IO_IMPORT =
  /(?:from\s*['"]node:(?:fs|zlib|child_process)['"]|import\s*['"]node:(?:fs|zlib|child_process)['"]|require\(\s*['"]node:(?:fs|zlib|child_process)['"]\s*\))/;

describe('判据1：零新增依赖 + src 无非豁免 IO', () => {
  it('package.json 的 dependencies 为空、devDependencies 恰为三项工具（无 zip/office 包）', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {}).sort();
    console.log('[D02A-V1] package.json deps', JSON.stringify({ deps, devDeps }));
    expect(deps).toEqual([]);
    expect(devDeps).toEqual(['@types/node', 'typescript', 'vitest']);
    const suspicious = [...deps, ...devDeps].filter((name) =>
      /zip|office|excel|word|ppt|ooxml|docx|xlsx|pptx|archiver/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('pnpm-lock.yaml 不含任何 zip / office 类第三方包名', () => {
    const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    const banned = [
      'jszip',
      'adm-zip',
      'archiver',
      'yauzl',
      'yazl',
      'exceljs',
      'docxtemplater',
      'pizzip',
      'pptxgenjs',
      'officegen',
      'unzipper',
    ];
    const hits = banned.filter((name) => lock.includes(name));
    expect(hits).toEqual([]);
  });

  it('src/**（非测试）没有任何 node:fs / node:zlib / node:child_process 的 import', () => {
    const files = walkSourceFiles(join(REPO_ROOT, 'src')).filter((file) => !file.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      // 归一成"仓库相对、正斜杠、无前导斜杠"的形态：`replace(REPO_ROOT,'')` 在不同盘符/分隔符下
      // 会给出带或不带前导斜杠两种结果，直接 `endsWith('/src/...')` 会因这种差异**假红**。
      const relativePath = file
        .replace(REPO_ROOT, '')
        .split('\\')
        .join('/')
        .replace(/^\/+/, '');
      // **合同 R50.4 的 2026-10-03 修订**：范围扩为"完整 App + 持久后台内核"后，
      // 持久 Store 本质上需要文件 IO，无法像 raw inflate 那样用纯 TS 绕开。
      // 因此放行**具名**的 IO 适配器（逐个文件列出，不用通配符；理由与反向对照见
      // `w-disc-kernel-discipline.test.ts` 的 `IO_ADAPTER_ALLOWLIST`）。其余 src/** 一律禁止。
      const isAllowedIoAdapter = relativePath === 'src/storage/file-store.ts';
      const text = readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!FORBIDDEN_IO_IMPORT.test(line)) continue;
        // 多行 import 的收尾行形如 `} from 'node:fs';` —— 同样按行匹配即可。
        if (isAllowedIoAdapter && /['"]node:(?:fs|path)['"]/.test(line)) continue;
        offenders.push(`${relativePath}: ${line.trim()}`);
      }
    }
    console.log('[D02A-V1] src 扫描文件数', files.length, '违规', offenders.length);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 2：确定性 ZIP（结构常量 + Python 独立解析）
// ---------------------------------------------------------------------------

const BUILDERS: readonly { readonly label: string; readonly build: () => { readonly bytes: Buffer; readonly entry_count: number } }[] = [
  { label: 'DOCX', build: buildDocx },
  { label: 'XLSX', build: buildXlsx },
  { label: 'PPTX', build: buildPptx },
];

describe('判据2：确定性 ZIP 的结构常量（三类产物各自断言）', () => {
  for (const { label, build } of BUILDERS) {
    it(`${label}：两次 writeZip 逐字节相等，且中央目录常量全部命中`, () => {
      const first = build();
      const second = build();
      expect(Buffer.compare(first.bytes, second.bytes)).toBe(0);

      const bytes = first.bytes;
      const central = readCentralEntries(bytes);
      expect(central.length).toBe(first.entry_count);
      expect(central.length).toBeGreaterThan(0);

      const eocdOffset = findEocdOffset(bytes);
      // 无 ZIP64 EOCD（否则 EOCD 之前还会有一段）：EOCD 必须正好在文件末尾 22 字节处。
      expect(eocdOffset + 22).toBe(bytes.length);

      for (const entry of central) {
        expect(entry.method).toBe(0); // STORE
        expect(entry.dosTime).toBe(0x0000);
        expect(entry.dosDate).toBe(0x0021);
        expect(entry.flags).toBe(0);
        expect(entry.extraLength).toBe(0);
        expect(entry.commentLength).toBe(0);
        expect(entry.versionMadeBy).toBe(20); // 常量，不由 process.platform 推导
        expect(entry.versionNeeded).toBe(20);
        expect(entry.internalAttributes).toBe(0);
        expect(entry.externalAttributes).toBe(0);
        expect(entry.compressedSize).toBe(entry.uncompressedSize);
      }

      for (const entry of readLocalEntries(bytes)) {
        expect(entry.method).toBe(0);
        expect(entry.dosTime).toBe(0x0000);
        expect(entry.dosDate).toBe(0x0021);
        expect(entry.flags).toBe(0);
        expect(entry.extraLength).toBe(0);
        expect(entry.versionNeeded).toBe(20);
      }

      // 本地条目顺序与中央目录顺序一致（顺序真的由声明决定，不被排序）。
      expect(readLocalEntries(bytes).map((entry) => entry.name)).toEqual(
        central.map((entry) => entry.name),
      );
      console.log(`[D02A-V1] ${label} 条目`, JSON.stringify(central.map((entry) => entry.name)));
    });
  }

  it('Python 独立解析（readbackArtifact）：testzip() 为 None 且 unzip -t 退出码 0', () => {
    const tools = requireToolchain();
    const cases: readonly { readonly label: string; readonly build: () => { readonly bytes: Buffer; readonly entry_count: number } }[] = [
      { label: 'DOCX', build: buildDocx },
      { label: 'XLSX', build: buildXlsx },
      { label: 'PPTX', build: buildPptx },
    ];

    for (const { label, build } of cases) {
      const built = build();
      const path = writeTemp(`v1-${label.toLowerCase()}.bin`, built.bytes);
      const readback = readbackArtifact(tools, path);

      console.log(
        `[D02A-V1] ${label} readback`,
        JSON.stringify({
          ok: readback.ok,
          bad_entry: readback.bad_entry,
          unzip_exit: readback.unzip_test.exit_code,
          xml_problems: readback.xml_problems.length,
          entries: readback.entries.length,
          python: readback.python.executable,
          unzip: readback.unzip.executable,
        }),
      );

      expect(readback.bad_entry).toBeNull(); // zipfile.testzip() === None
      expect(readback.unzip_test.exit_code).toBe(0);
      expect(readback.xml_problems).toEqual([]);
      expect(readback.ok).toBe(true);
      expect(readback.entries.length).toBe(built.entry_count);
      expect(readback.entries.map((entry) => entry.name)).toEqual(
        readCentralEntries(built.bytes).map((entry) => entry.name),
      );
      // Python 侧 CRC 与本文件独立实现的 CRC-32 一致（换实现交叉核对）。
      for (const entry of readback.entries) {
        const raw = partBytesOf(built.bytes, entry.name);
        expect(entry.crc32 >>> 0).toBe(crc32(raw) >>> 0);
        expect(entry.size).toBe(raw.length);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 判据 3：golden 摘要独立复算（W-A / W-D1 / W-D2 / W-D3）
// ---------------------------------------------------------------------------

// W-A：writeZip 的 golden 部件清单（与 zip.test.ts 的写死输入逐字一致）。
const W_A_ENTRIES = [
  {
    path: 'docProps/core.xml',
    data: new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties>中文标题</cp:coreProperties>',
    ),
  },
  { path: 'word/document.xml', data: new TextEncoder().encode('<w:document/>') },
  { path: 'word/media/empty.bin', data: new Uint8Array(0) },
];

const W_A_GOLDEN_SHA256 = '698b1dd190aa3b25c9767eb5f815402640ab66f2653012a2f188aa695efdc05e';
const W_A_GOLDEN_LENGTH = 478;
const W_D1_GOLDEN_SHA256 = 'cf4254beb67ea789dc04d250cbdbd4c47c14325576626c9b5c849475e984d55d';
const W_D1_GOLDEN_LENGTH = 1773;
const W_D2_GOLDEN_SHA256 = 'e01ea88d0e1f28d0913d9907faf0035776d870fc31fc743626f729281406694e';
const W_D2_EMPTY_SHA256 = 'ca1292adfe6bf3065b93b4fb24ba97a35252fd6fbd4e421db3cb85a447296ca4';
const W_D3_GOLDEN_SHA256 = 'b0d40fb7dea956fa0a196377e57f9e711ba12235372703626b463f781087e260';
const W_D3_GOLDEN_LENGTH = 14335;

describe('判据3：golden 摘要独立复算（真实字节 → sha256，逐条对照写死常量）', () => {
  it('W-A：writeZip(golden 部件清单) 的 sha256 / 长度 / 逐条 CRC', () => {
    const bytes = writeZip(W_A_ENTRIES);
    const digest = sha256(bytes);
    console.log('[D02A-V1] W-A 复算', JSON.stringify({ digest, length: bytes.length }));
    expect(bytes.length).toBe(W_A_GOLDEN_LENGTH);
    expect(digest).toBe(W_A_GOLDEN_SHA256);

    const central = readCentralEntries(bytes);
    expect(central.map((entry) => entry.name)).toEqual(W_A_ENTRIES.map((entry) => entry.path));
    // Python 回读单测记录的 CRC：0x458281ab / 0x0d865add / 0x00000000 —— 本文件独立复算。
    expect(crc32(W_A_ENTRIES[0]!.data)).toBe(0x458281ab);
    expect(crc32(W_A_ENTRIES[1]!.data)).toBe(0x0d865add);
    expect(crc32(W_A_ENTRIES[2]!.data)).toBe(0x00000000);
  });

  it('W-D1：DOCX golden 输入 ⇒ 长度与 sha256 命中写死常量', () => {
    const built = buildDocx();
    const digest = sha256(built.bytes);
    console.log('[D02A-V1] W-D1 复算', JSON.stringify({ digest, length: built.bytes.length }));
    expect(built.bytes.length).toBe(W_D1_GOLDEN_LENGTH);
    expect(digest).toBe(W_D1_GOLDEN_SHA256);
    expect(built.content_digest).toBe(digest);
    expect(built.entry_count).toBe(3);
  });

  it('W-D2：XLSX 基准 golden 与空快照 golden 两条摘要都命中', () => {
    const base = buildXlsx();
    const baseDigest = sha256(base.bytes);
    const empty = buildXlsxTemplate(XLSX_SPEC, []);
    const emptyDigest = sha256(empty.bytes);
    console.log('[D02A-V1] W-D2 复算', JSON.stringify({ baseDigest, emptyDigest }));
    expect(baseDigest).toBe(W_D2_GOLDEN_SHA256);
    expect(emptyDigest).toBe(W_D2_EMPTY_SHA256);
    expect(base.content_digest).toBe(baseDigest);
    expect(base.entry_count).toBe(5);
    expect(empty.entry_count).toBe(5);
  });

  it('W-D3：PPTX golden 输入 ⇒ 长度与 sha256 命中写死常量', () => {
    const built = buildPptx();
    const digest = sha256(built.bytes);
    console.log('[D02A-V1] W-D3 复算', JSON.stringify({ digest, length: built.bytes.length }));
    expect(built.bytes.length).toBe(W_D3_GOLDEN_LENGTH);
    expect(digest).toBe(W_D3_GOLDEN_SHA256);
    expect(built.content_digest).toBe(digest);
    expect(built.entry_count).toBe(13);
  });

  it('Python hashlib 独立复算同一个文件 ⇒ 与 node:crypto 结果一致（换语言交叉核对）', () => {
    const tools = requireToolchain();
    const cases: readonly {
      readonly label: string;
      readonly build: () => { readonly bytes: Buffer };
      readonly golden: string;
    }[] = [
      { label: 'DOCX', build: buildDocx, golden: W_D1_GOLDEN_SHA256 },
      { label: 'XLSX', build: buildXlsx, golden: W_D2_GOLDEN_SHA256 },
      { label: 'PPTX', build: buildPptx, golden: W_D3_GOLDEN_SHA256 },
    ];
    for (const { label, build, golden } of cases) {
      const bytes = build().bytes;
      const path = writeTemp(`sha-${label.toLowerCase()}.bin`, bytes);
      const digest = pythonSha256(tools.python.executable, path);
      console.log(`[D02A-V1] ${label} python sha256`, digest);
      expect(digest).toBe(golden);
      expect(digest).toBe(sha256(bytes));
    }
  });
});

// ---------------------------------------------------------------------------
// 判据 4：属性顺序真的进了字节
// ---------------------------------------------------------------------------

function packageWithPartXml(partXml: string): Buffer {
  const assembled = assembleOpcPackage({
    parts: [{ path: 'a.xml', content_type: 'application/xml', data: partXml }],
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships: [
      { owner_part_path: null, declarations: [{ type: 'http://example.com/rel', target: 'a.xml' }] },
    ],
  });
  return writeZip(assembled.entries);
}

describe('判据4：属性顺序真的进了字节（不是空话）', () => {
  it('只换属性顺序 ⇒ 序列化文本、容器字节、sha256 全不同', () => {
    const idFirst = serializeXmlDocument(
      el('root', [attr('Id', 'rId1'), attr('Type', 'T')], []),
    );
    const typeFirst = serializeXmlDocument(
      el('root', [attr('Type', 'T'), attr('Id', 'rId1')], []),
    );

    expect(idFirst).not.toBe(typeFirst);
    expect(idFirst.indexOf('Id=')).toBeLessThan(idFirst.indexOf('Type='));
    expect(typeFirst.indexOf('Type=')).toBeLessThan(typeFirst.indexOf('Id='));

    const firstBytes = packageWithPartXml(idFirst);
    const secondBytes = packageWithPartXml(typeFirst);
    expect(Buffer.compare(firstBytes, secondBytes)).not.toBe(0);
    expect(sha256(firstBytes)).not.toBe(sha256(secondBytes));

    // 两份部件除属性顺序外内容相同：把属性文本互换后应还原成同一段。
    expect(idFirst.replace(' Id="rId1" Type="T"', ' Type="T" Id="rId1"')).toBe(typeFirst);
    console.log('[D02A-V1] 属性顺序 sha256', JSON.stringify({ a: sha256(firstBytes), b: sha256(secondBytes) }));
  });

  it('反例对照：属性顺序相同 ⇒ 字节相同（证明上一条不是"凡构建就不同"）', () => {
    const xml = serializeXmlDocument(el('root', [attr('Id', 'rId1'), attr('Type', 'T')], []));
    expect(sha256(packageWithPartXml(xml))).toBe(sha256(packageWithPartXml(xml)));
  });
});

// ---------------------------------------------------------------------------
// 判据 5：XML 无 BOM、声明一致、换行 \n
// ---------------------------------------------------------------------------

describe('判据5：全部 XML 部件无 BOM / 声明一致 / 换行固定 \\n', () => {
  for (const { label, build } of BUILDERS) {
    it(`${label}：每个 .xml/.rels 部件都以固定声明开头、无 BOM、无 \\r`, () => {
      const { bytes } = build();
      const parts = xmlPartsOf(bytes);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        expect(part.text.startsWith(`${XML_DECLARATION}\n`)).toBe(true);
        expect(part.text.charCodeAt(0)).not.toBe(0xfeff);
        expect(part.text).not.toContain('﻿');
        expect(part.text).not.toContain('\r');
        // 声明只在开头出现一次，不重复。
        expect(part.text.split(XML_DECLARATION).length - 1).toBe(1);
        // 原始字节的第一个字节是 '<'，不是 UTF-8 BOM 的 0xEF。
        const raw = partBytesOf(bytes, part.name);
        expect(raw[0]).toBe(0x3c);
      }
      console.log(`[D02A-V1] ${label} XML 部件数`, parts.length);
    });
  }
});

// ---------------------------------------------------------------------------
// 判据 6：模板边界可证伪
// ---------------------------------------------------------------------------

describe('判据6a：DOCX 边界 —— 凭空数字真的被拒（自造负例）', () => {
  it('正文里出现快照没有的数字 77 ⇒ 构建器抛错', () => {
    // 断言检查器本身先抓住 77（自造文本，与既有单测用例无关）。
    expect(untraceableDigitRuns('本次共 77 人参加', DOCX_SNAPSHOT)).toEqual(['77']);
    // 2030-01-01 的两个数字串都指认不到快照的 2026-10-02（原子掩码按整串匹配）。
    expect(untraceableDigitRuns('会议在 2030-01-01 举行', DOCX_SNAPSHOT)).toEqual(['2030', '01']);

    expect(() =>
      buildDocxTemplate({
        requirement: { title: '安排调整', description: '本次共 77 人参加。' },
        fact_snapshot: DOCX_SNAPSHOT,
        references: [],
      }),
    ).toThrow(/77/);
  });

  it('控制组：同一数字若确为快照值（8）⇒ 正常产出，检查器不报', () => {
    const built = buildDocxTemplate({
      requirement: { title: '安排确认', description: '已确认人数为 8 人。' },
      fact_snapshot: DOCX_SNAPSHOT,
      references: [],
    });
    expect(built.entry_count).toBe(3);
    const text = partBytesOf(built.bytes, 'word/document.xml').toString('utf8');
    expect(text).toContain('已确认人数为 8 人。');
  });
});

describe('判据6b：XLSX 边界 —— 缺失不当零 vs 已知的零', () => {
  const spec: XlsxSheetSpec = {
    sheet_name: '预算',
    label_header: '项目',
    value_header: '金额',
    unit: '元',
    lines: [
      { label: '甲项', fact_key: 'a' },
      { label: '乙项', fact_key: 'b' },
    ],
    total_label: '合计',
    scale: 2,
  };

  const unknownB: XlsxFactEntry = {
    fact_ref: asFactRef('fact-b'),
    fact_key: 'b',
    value: { kind: 'unknown', reason: '用户未提供' },
    source: { kind: 'user_confirmation', detail: '前台确认' },
  };

  it('未知事实 ⇒ 值单元格整格不写、全文无 <v>0</v>，合计也留空', () => {
    const sheet = buildXlsxSheetXml(spec, [xlsxFact('a', 10), unknownB]);
    console.log('[D02A-V1] XLSX unknown sheet', sheet);

    expect(sheet).not.toContain('<c r="B3"'); // 乙项值格（第 3 行 B 列）整个不存在
    expect(sheet).not.toContain('<v>0</v>');
    expect(sheet).not.toContain('<v>0.00</v>');
    expect(sheet).not.toContain('<c r="B4"'); // 合计格（第 4 行 B 列）也留空
    // 标签仍在，证明"没写"不是"整行丢了"。
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t>乙项</t></is></c>');
    expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t>合计</t></is></c>');
    // 甲项仍写其真实值。
    expect(sheet).toContain('<c r="B2"><v>10.00</v></c>');
  });

  it('已知的 0 ⇒ 必须照写 <v>0.00</v>（证明判的是"缺失 vs 零"，不是"禁止 0"）', () => {
    const sheet = buildXlsxSheetXml(spec, [xlsxFact('a', 0), xlsxFact('b', 0)]);
    console.log('[D02A-V1] XLSX zero sheet', sheet);

    expect(sheet).toContain('<c r="B2"><v>0.00</v></c>');
    expect(sheet).toContain('<c r="B3"><v>0.00</v></c>');
    expect(sheet).toContain('<c r="B4"><v>0.00</v></c>'); // 合计 = 0，是算出来的
  });

  it('缺失键（快照里根本没有）⇒ 同样留空，且与"未知"区分得开', () => {
    const sheet = buildXlsxSheetXml(spec, [xlsxFact('a', 10)]);
    expect(sheet).not.toContain('<c r="B3"');
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t>乙项</t></is></c>');
  });
});

describe('判据6c：PPTX 边界 —— 产物里的每个数字都能指认到快照', () => {
  /** 幻灯片文本里出现的全部数字串。 */
  function slideDigitRuns(bytes: Buffer): readonly string[] {
    const texts = xmlPartsOf(bytes)
      .filter((part) => part.name.startsWith('ppt/slides/slide'))
      .map((part) => part.text);
    const runs: string[] = [];
    for (const text of texts) {
      const matches = text.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
      for (const match of matches) {
        const inner = match.replace(/^<a:t>/, '').replace(/<\/a:t>$/, '');
        for (const run of inner.match(/[0-9]+/g) ?? []) runs.push(run);
      }
    }
    return [...new Set(runs)];
  }

  it('每个数字串都能指认到某一条快照事实的渲染行', () => {
    const built = buildPptx();
    const runs = slideDigitRuns(built.bytes);
    expect(runs.length).toBeGreaterThan(0);

    const renderedLines = PPTX_SNAPSHOT.map((entry) => renderFactLine(entry));
    for (const run of runs) {
      const traceable = renderedLines.some((line) => line.includes(run));
      expect(traceable, `数字 ${run} 指认不到任何快照事实（渲染行：${renderedLines.join(' | ')}）`).toBe(
        true,
      );
    }
    console.log('[D02A-V1] PPTX digits', JSON.stringify({ runs, renderedLines }));
  });

  it('可证伪：往快照里加一条 987654 ⇒ 产物里出现该数字且可指认；移除 ⇒ 消失', () => {
    const withExtra = buildPptx([
      ...PPTX_SNAPSHOT,
      fact('metric.code', { type: 'number', amount: 987654, unit: '项', currency: null }),
    ]);
    const runsWith = slideDigitRuns(withExtra.bytes);
    expect(runsWith).toContain('987654');
    const linesWith = [
      ...PPTX_SNAPSHOT,
      fact('metric.code', { type: 'number', amount: 987654, unit: '项', currency: null }),
    ].map((entry) => renderFactLine(entry));
    expect(linesWith.some((line) => line.includes('987654'))).toBe(true);

    expect(slideDigitRuns(buildPptx().bytes)).not.toContain('987654');
  });

  it('非事实文本含数字 ⇒ 构建期直接拒绝（不静默、不截断）', () => {
    expect(() =>
      buildPresentation({
        title: '2026 年会筹备方案',
        goal: '向管理层说明进展',
        audience: '公司管理层',
        fact_snapshot: PPTX_SNAPSHOT,
      }),
    ).toThrow(/含数字/);
  });
});

// ---------------------------------------------------------------------------
// 判据 7：跨调用可复现
// ---------------------------------------------------------------------------

describe('判据 7：跨调用可复现（同输入构造两次 ⇒ sha256 相等）', () => {
  it('三类产物：两次构建（中间穿插不同产物的构建）⇒ 字节与摘要一致', () => {
    const docx1 = buildDocx();
    const xlsx1 = buildXlsx();
    buildPptx(); // 扰动可能的模块级可变状态
    const docx2 = buildDocx();
    const pptx1 = buildPptx();
    const xlsx2 = buildXlsx();
    const pptx2 = buildPptx();

    expect(Buffer.compare(docx1.bytes, docx2.bytes)).toBe(0);
    expect(Buffer.compare(xlsx1.bytes, xlsx2.bytes)).toBe(0);
    expect(Buffer.compare(pptx1.bytes, pptx2.bytes)).toBe(0);
    expect(sha256(docx1.bytes)).toBe(sha256(docx2.bytes));
    expect(sha256(xlsx1.bytes)).toBe(sha256(xlsx2.bytes));
    expect(sha256(pptx1.bytes)).toBe(sha256(pptx2.bytes));
  });

  it('进程外复现（子 node 进程读同一份落盘字节）⇒ sha256 与进程内一致', () => {
    // 说明：这里验证的是"同一份字节在另一个进程里得到同一摘要"，不是第二次构造
    //（跨进程二次构造需要能直接 import TS 源码，Node 的 .js→.ts 解析不成立）。
    const built = buildDocx();
    const path = writeTemp('repro.docx', built.bytes);
    const script =
      'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");' +
      'const b=readFileSync(process.argv[1]);console.log(createHash("sha256").update(b).digest("hex"))';
    const out = execFileSync(process.execPath, ['-e', script, path], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    expect(out.trim()).toBe(sha256(built.bytes));
  });
});

// ---------------------------------------------------------------------------
// 判据 8：结构自检与 Python 回读交叉核对（部件清单与关键文本）
// ---------------------------------------------------------------------------

describe('判据8：条目清单与关键文本交叉核对', () => {
  it('DOCX/XLSX/PPTX 的部件清单与内容类型覆盖一致，关键文本可回读', () => {
    const tools = requireToolchain();

    const docxPath = writeTemp('docx-check.docx', buildDocx().bytes);
    const docxReadback = readbackArtifact(tools, docxPath);
    expect(docxReadback.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
    expect(docxReadback.part_text['word/document.xml']).toContain('headcount: 8 人');
    expect(docxReadback.part_text['word/document.xml']).toContain('budget.total: 600 CNY');
    expect(docxReadback.rels_targets['_rels/.rels']).toEqual(['word/document.xml']);

    const xlsxBytes = buildXlsx().bytes;
    const xlsxPath = writeTemp('xlsx-check.xlsx', xlsxBytes);
    const xlsxReadback = readbackArtifact(tools, xlsxPath);
    expect(xlsxReadback.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/_rels/workbook.xml.rels',
    ]);
    expect(xlsxReadback.part_text['xl/worksheets/sheet1.xml']).toContain('1950.50'); // 1200+300+450.5
    // 工作表名是 XML 属性（不是文本节点），itertext() 取不到 ⇒ 直接看原始部件字节。
    expect(partBytesOf(xlsxBytes, 'xl/workbook.xml').toString('utf8')).toContain('预算');
    expect(partBytesOf(xlsxBytes, 'xl/workbook.xml').toString('utf8')).toContain(
      'r:id="rId1"',
    );

    const pptxBytes = buildPptx().bytes;
    const pptxPath = writeTemp('pptx-check.pptx', pptxBytes);
    const pptxReadback = readbackArtifact(tools, pptxPath);
    expect(pptxReadback.entries.length).toBe(13);
    // `ppt/presentation.xml` 的内容全在属性里（itertext() 为空）⇒ 看原始部件字节。
    expect(partBytesOf(pptxBytes, 'ppt/presentation.xml').toString('utf8')).toContain(
      'r:id="rId1"',
    );
    const slide1 = pptxReadback.part_text['ppt/slides/slide1.xml'] ?? '';
    expect(slide1).toContain('年会筹备方案');

    for (const readback of [docxReadback, xlsxReadback, pptxReadback]) {
      expect(Object.values(readback.part_has_bom).every((flagged) => !flagged)).toBe(true);
    }
  });
});
