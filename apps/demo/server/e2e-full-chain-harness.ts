/**
 * 工作包 **FA-E2E-FULL-CHAIN** 的独立夹具：**自带 ZIP 读取器** + 产品服务启停 + HTTP 小工具。
 *
 * ## 为什么 ZIP 读取器要「自带」，而且**要能读条目原始字节**
 *
 * 本套件有两条判据必须由**独立量尺**回答：
 *
 * 1. **三个产物同版**：数值来自同一事实版本 ⇒ 必须把**交付字节里真正写了什么**读出来，
 *    而不是相信响应体里那句"我写了 10"。
 * 2. **无关内容不重写**：未受影响的段落 / 工作表 / 页**逐部件字节不变** ⇒ 必须能取到
 *    **单个部件（`word/document.xml` / `xl/worksheets/sheetN.xml` / `ppt/slides/slideN.xml`）
 *    的原始字节**再比字节。
 *
 * 若拿内核自己的结构自检器（`src/artifacts/verify.ts`）来读回，那么"自检器分不清格式"
 * 或"自检器与写者共用同一套假设"这类缺陷会**同时污染被测对象与量尺**。因此这里的读取器
 * **只依赖 ZIP 的字节布局**（EOCD → 中央目录 → 本地头 → 数据区），
 * **不 import 本仓任何模块**；解压只用 `node:zlib` 的 `inflateRawSync`（stored 原样取）。
 *
 * 支持的压缩方法：0（stored）/ 8（deflate）。其余方法如实抛错，不假装读到。
 *
 * ## 为什么经 `createDemoServer` 起服务
 *
 * 任务要求"真实 HTTP + 真实落盘 + 产品入口"。`createDemoServer` 正是产品入口：它按环境变量
 * 解析运行目录、建**落盘的内核存储**（`<runDir>/kernel-store/store.json`）、组装会话 / 交付 /
 * 适配器 / 记忆 / 模板 / 闭环等宿主，并挂到同一条 `createDemoRequestHandler` 上。
 * 夹具只把它 `listen(0, '127.0.0.1')`，**不替换任何一层**。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';

import { createDemoServer, type DemoServer } from './main.js';

// ---------------------------------------------------------------------------
// 独立 ZIP 读取器（只依赖 ZIP 字节布局）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** EOCD 定长部分；注释最长 65535 是 ZIP 规范，扫描窗口取该上界。 */
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
/** 中央目录记录定长头 46 字节；本地文件头定长部分 30 字节。 */
const CENTRAL_FIXED_LENGTH = 46;
const LOCAL_FIXED_LENGTH = 30;

export interface ZipEntry {
  readonly name: string;
  /** 解压后的条目**原始字节**。 */
  readonly bytes: Uint8Array;
}

function eocdOffsetOf(view: DataView, byteLength: number): number {
  const scanFrom = Math.max(0, byteLength - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  for (let offset = byteLength - EOCD_MIN_LENGTH; offset >= scanFrom; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('不是合法 ZIP：找不到 EOCD（0x06054b50）');
}

/**
 * 读出 ZIP 包内全部条目（名字 + 解压后的原始字节）。
 *
 * @throws 找不到 EOCD / 中央目录或本地头签名不符 / 压缩方法不是 0 或 8。
 */
export function readZipEntries(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = eocdOffsetOf(view, bytes.byteLength);
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`条目 ${name} 的本地文件头签名不符（不是合法 ZIP）`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + LOCAL_FIXED_LENGTH + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.push({ name, bytes: new Uint8Array(raw) });
    } else if (method === 8) {
      entries.push({ name, bytes: new Uint8Array(inflateRawSync(raw)) });
    } else {
      throw new Error(`条目 ${name} 的压缩方法 ${String(method)} 不受支持（只支持 0 / 8）`);
    }
  }
  return Object.freeze(entries);
}

/** 包内部件名清单（保持中央目录顺序）。 */
export function zipEntryNames(bytes: Uint8Array): readonly string[] {
  return Object.freeze(readZipEntries(bytes).map((entry) => entry.name));
}

/** 部件名 → 原始字节。 */
export function zipEntryMap(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const entry of readZipEntries(bytes)) {
    map.set(entry.name, entry.bytes);
  }
  return map;
}

/** 取某个部件的文本（UTF-8）；部件不存在 ⇒ 抛（不返回空串冒充"读到了但为空"）。 */
export function partText(bytes: Uint8Array, partName: string): string {
  const map = zipEntryMap(bytes);
  const part = map.get(partName);
  if (part === undefined) {
    throw new Error(`包里没有部件 ${partName}（有的部件：${[...map.keys()].join(', ')}）`);
  }
  return new TextDecoder('utf-8').decode(part);
}

// ---------------------------------------------------------------------------
// 摘要 / 文本
// ---------------------------------------------------------------------------

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 两个部件字节是否**逐字节相同**（长度 + 每一位）。 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 产品服务启停
// ---------------------------------------------------------------------------

export interface RunningProduct {
  readonly demo: DemoServer;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * 经**产品入口**起一个真实服务（`createDemoServer` + `listen`）。
 *
 * 环境只给 `POTBOT_RUN_DIR`：模型配置一律缺席 ⇒ 模型端口如实为 `null`（本套件不碰模型）。
 * 端口用 `0` 让内核分配，避免与并行工作者抢固定端口。
 */
export async function startProduct(runDir: string): Promise<RunningProduct> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  const server: Server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    demo,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

export interface JsonResponse {
  readonly status: number;
  readonly json: Json;
}

export async function postJson(baseUrl: string, path: string, body?: unknown): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

export async function getJson(baseUrl: string, path: string): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Json };
}

export interface DownloadedBytes {
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}

/** 取下载面的**原始字节**（不解析 JSON，供独立 ZIP 读取器读回）。 */
export async function getBytes(baseUrl: string, path: string): Promise<DownloadedBytes> {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 从任意 JSON 里取对象字段（缺失 / 非对象 ⇒ `null`）。 */
export function objectOf(body: Json, key: string): Json | null {
  const value = body[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}
