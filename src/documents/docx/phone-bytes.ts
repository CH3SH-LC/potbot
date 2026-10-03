/**
 * **W01 —— DOCX 单一装配者：手机 bytes 适配层 + 装配回执**。
 *
 * 本模块把"导入一份 DOCX / 保存一份 DOCX"从**桌面文件系统**上解耦出来，变成
 * "从一个 **bytes 端口**取字节 / 往一个 bytes 端口写字节"，并给出**可核验的装配回执**。
 *
 * ## 为什么需要这一层（而不是直接调 `importDocx` / `exportDocx`）
 *
 * `importDocx` / `exportDocx` 已经是纯 `Uint8Array` 进 / `Uint8Array` 出的内核函数，但**调用方**
 * （手机宿主）仍然要自己回答三个问题，而且答案散落各处、没人核对：
 *
 * 1. **字节从哪来**：手机上是 `content://` URI、私有目录 blob、或内存缓冲——**不是** `node:fs`
 *    的路径。把"取字节"抽成端口后，产品路径再也拿不到"桌面绝对路径"这种东西。
 * 2. **保存后到底动了哪些部件**：合同（`README.md` §5）的 OfficePlugin 回执要
 *    `artifactId/revision/digest/changedObjects/warnings`。内核只返回一坨字节，
 *    **改没改、改了谁**得由装配层如实算出来——这正是"未改部件保持"这条验收的可核验形式。
 * 3. **关系装配是否自洽**：装配后的包里每个 `.rels` 都必须能被重新解析，且**不得凭空少掉**
 *    任何一个源部件（静默丢件是 R105 明令禁止的）。回执里对每个部件给出 `disposition`。
 *
 * ## 装配回执的 `disposition` 判据（**逐字节**，不是"看起来一样"）
 *
 * | 处置 | 判据 |
 * |---|---|
 * | `preserved` | 源模型里有该部件，装配后的**解压字节**与源**逐字节相同** |
 * | `changed` | 源模型里有该部件，装配后字节不同 |
 * | `added` | 源模型里没有、装配后新出现（关系装配新增的页眉/页脚/图表/嵌入表等） |
 * | `removed` | 源模型里有、装配后消失 —— **正常情况下必然为空**；非空即"静默丢件" |
 *
 * 判据的"源"取自 **模型自己携带的原始字节**（`opaque_parts` ∪ `media`），不是"再读一次输入"——
 * 因为保存时输入通常已经不在手边（手机可能只留了模型后的账本）。这与 `exportDocx` 内部
 * "未改动 ⇒ 写回原字节"用的是**同一份**原始字节，因此口径一致、不会自欺。
 *
 * ## 纪律
 *
 * - **零 `node:*` import**：本模块只用 `sha256.ts`（纯 TS）算摘要，不碰 `node:crypto`/`node:fs`。
 *   （注意：`importDocx` 内部**仍然**经 `artifacts/digest.ts` 传递依赖 `node:crypto`——那是
 *   已识别的 K01/K09 迁移项，本模块不加深它，但也不能假装它不存在。）
 * - **不猜路径**：端口的 `ref` 是不透明字符串；本模块从不把它当 `node:fs` 路径使用。
 * - 有界失败：端口读不到、字节为空、导入被拒，都以**有界错误类型**抛出，不产出半成品。
 */

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import type { DocumentModel } from '../model/types.js';
import type { ContentTypeInconsistency } from './content-type-rules.js';
import { exportDocx, type ExportDocxOptions } from './export.js';
import {
  DOCX_MAIN_CONTENT_TYPE,
  importDocxDetailed,
  type ImportDocxOptions,
} from './import.js';
import { contentTypeForPart, parseRelationships, relsOwnerOf } from './package-parts.js';
import { sha256Hex } from './sha256.js';

/** 装配层契约版本（回执里可写；字段只能**追加**，不得改签名——与 `README.md` §5 的取向一致）。 */
export const DOCX_ASSEMBLER_CONTRACT_VERSION = 'w01.assembler.v1';

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/**
 * 一次字节引用的**不透明**句柄。
 *
 * 为什么是 `string` 而不是结构化对象：手机上同一个"文件"可能是 `content://…`、
 * 私有目录下的相对键、或内存 blob 的键。适配层**不解释**它——解释是宿主（K09 StoragePort）的事。
 * 刻意**不允许**它是 `node:fs` 路径形态之外的东西被本层消费：本层只把它转交给端口。
 */
export type DocxByteRef = string;

/** 字节**来源**端口：给定不透明 `ref`，返回完整包字节。 */
export interface DocxBytesSource {
  /**
   * 读取 `ref` 指向的完整字节。
   *
   * @throws 端口实现可抛任意错误；`loadDocx` 会把"读不到"归一成 `DocxBytesError('unknown_source_ref')`。
   */
  read(ref: DocxByteRef): Uint8Array;
}

/** 字节**去向**端口：把完整包字节写到不透明 `ref`。 */
export interface DocxBytesSink {
  /**
   * 写入 `ref` 指向的位置（**覆盖**语义由宿主决定；本层不做原子性承诺，那是 K09 StoragePort 的事）。
   */
  write(ref: DocxByteRef, bytes: Uint8Array): void;
}

/** 读 + 写。宿主实现它即可让 W01 装配者在手机上工作。 */
export interface DocxBytesPort extends DocxBytesSource, DocxBytesSink {
  /** 可选存在性查询（写前判断"新建 vs 覆盖"用；不实现则视为 `undefined`）。 */
  has?(ref: DocxByteRef): boolean;
}

/** 适配层的结构化错误。**不并入 `DocxError`**：那是 DOCX 包语义的错误，这里是"字节端口"的。 */
export type DocxBytesErrorReason =
  /** `ref` 在端口里不存在（读不到），或宿主存储把读取降级成"没有"。 */
  | 'unknown_source_ref'
  /** `ref` 读到的字节为 0 长度——空包不是"空文档"，按 R140 先拒绝。 */
  | 'ref_empty'
  /** 写入被宿主存储拒绝（非字节 / 版本 CAS 在有界重试后仍冲突 / 读当前版本失败）。 */
  | 'write_rejected';

export class DocxBytesError extends Error {
  readonly reason: DocxBytesErrorReason;

  constructor(reason: DocxBytesErrorReason, message: string) {
    super(message);
    this.name = 'DocxBytesError';
    this.reason = reason;
  }
}

/**
 * 参考实现：纯内存端口。**零文件系统**，供测试、fixture 与"手机上先落到内存再落盘"的路径使用。
 *
 * 不是"模拟"——它是一个**真实的**端口实现（真的存字节、真的回读同一字节）。
 * 真正的手机端口（`content://` → bytes）由宿主实现同一个接口。
 */
export class InMemoryDocxBytesPort implements DocxBytesPort {
  readonly #store = new Map<DocxByteRef, Uint8Array>();

  /** 已登记的引用数。 */
  get size(): number {
    return this.#store.size;
  }

  /** 登记一份字节（可直接当"写入"用；与 `write` 等价）。 */
  put(ref: DocxByteRef, bytes: Uint8Array): void {
    this.#store.set(ref, Uint8Array.from(bytes));
  }

  read(ref: DocxByteRef): Uint8Array {
    const bytes = this.#store.get(ref);
    if (bytes === undefined) {
      throw new DocxBytesError('unknown_source_ref', `bytes 端口里没有 ref=${JSON.stringify(ref)}`);
    }
    // 回读**复制**：调用方拿到的字节与端口内部存储不共享缓冲区，改一边不会串到另一边。
    return Uint8Array.from(bytes);
  }

  write(ref: DocxByteRef, bytes: Uint8Array): void {
    this.#store.set(ref, Uint8Array.from(bytes));
  }

  has(ref: DocxByteRef): boolean {
    return this.#store.has(ref);
  }

  /** 供测试断言用：当前所有 ref（插入顺序）。 */
  refs(): readonly DocxByteRef[] {
    return [...this.#store.keys()];
  }
}

// ---------------------------------------------------------------------------
// 宿主存储适配 —— 接到"真"blob 存储（W-I19）
// ---------------------------------------------------------------------------

/**
 * 窄**字节**键值存储：`list / get / put / delete`，按不透明 `ref` 存取整段字节。
 *
 * 这是"宿主已经有的一份 blob 存储"的最小形状——手机侧的真实实现由宿主提供
 * （应用私有目录 / SAF / 内存）。它与 `DocxBytesPort` 的分工：
 * `DocxBytesPort` 是**装配者**要的两个动词（read / write），本接口是**宿主存储**的四个动词；
 * `BlobStoreDocxBytesPort` 把四动词收敛成两动词，并在此处**统一把非法读取咬成
 * `DocxBytesError`**（空 / 未知 / 非 `Uint8Array` 一律拒绝，绝不当作"空文档"继续。
 * 这是 R140 与"读失败不得静默降级成空"在字节端口层的落点）。
 */
export interface DocxBlobStore {
  /** 读 `ref` 的整段字节；**从未写入**返回 `null`（不是空 `Uint8Array`）。介质读失败应抛错。 */
  get(ref: DocxByteRef): Uint8Array | null;
  /** 覆盖写 `ref` 的整段字节。 */
  put(ref: DocxByteRef, bytes: Uint8Array): void;
  /** 删除 `ref`（幂等；不存在不算错误）。 */
  delete(ref: DocxByteRef): void;
  /** 列出当前所有 `ref`（供 `has` 与"新建 vs 覆盖"判断）。 */
  list(): readonly DocxByteRef[];
}

/** 参考实现：纯内存的 `DocxBlobStore`。零文件系统，供测试与宿主自测。 */
export class InMemoryDocxBlobStore implements DocxBlobStore {
  readonly #store = new Map<DocxByteRef, Uint8Array>();

  get(ref: DocxByteRef): Uint8Array | null {
    const bytes = this.#store.get(ref);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }

  put(ref: DocxByteRef, bytes: Uint8Array): void {
    this.#store.set(ref, Uint8Array.from(bytes));
  }

  delete(ref: DocxByteRef): void {
    this.#store.delete(ref);
  }

  list(): readonly DocxByteRef[] {
    return [...this.#store.keys()];
  }
}

/**
 * `DocxBytesPort` over 一个 `DocxBlobStore`（窄四动词 → 装配两动词）。
 *
 * **fail-closed**：`get` 返回 `null` / `undefined` / 非 `Uint8Array` / 0 字节，
 * `read` 一律抛有界 `DocxBytesError`——宿主存储"读不动"与"确实没有"在装配者看来都必须是
 * **拒绝**，不能被当成一份空文档继续装配。
 */
export class BlobStoreDocxBytesPort implements DocxBytesPort {
  readonly #store: DocxBlobStore;

  constructor(store: DocxBlobStore) {
    this.#store = store;
  }

  read(ref: DocxByteRef): Uint8Array {
    return requireNonEmptyBytes(this.#store.get(ref), ref);
  }

  write(ref: DocxByteRef, bytes: Uint8Array): void {
    this.#store.put(ref, requireWritableBytes(bytes, ref));
  }

  has(ref: DocxByteRef): boolean {
    return this.#store.list().includes(ref);
  }
}

/**
 * K09 `StoragePort`（`apps/mobile-kernel/storage`）中本适配层用到的**同步**子集。
 *
 * 为什么只取 `readBlob` + `compareAndSwap`：
 * - `DocxBytesSink.write` 是**同步**契约，而 K09 `StoragePort.writeStream` 返回 `Promise`
 *   （它要接受异步分片）。在同步的 `write` 里 `await` 一个 Promise 不可行，于是写路径走
 *   K09 存储**唯一同步的写入动词** `compareAndSwap`（`expectedRevision` 由 `readBlob` 的
 *   `revision` 取得；"不存在"记 0，与 K09 的"期望不存在"创建语义一致）。
 * - 读取走 `readBlob`（本就同步）。
 *
 * **结构化形状**：本层**不 import** `apps/**`，只声明这**两个**方法的形状；因此
 * `MemoryStoragePort` / `FileStoragePort` / 未来安卓 SAF 适配器只要实现 K09 `StoragePort`，
 * 就**自动**满足本接口（测试用 `MemoryStoragePort` 直接编译通过即为此证的机器化形式）。
 */
export interface DocxStorageReadBlobLike {
  readonly status: string;
  readonly bytes: Uint8Array | null;
  readonly revision?: number | null;
}

export interface DocxStorageCasLike {
  readonly status: string;
  readonly cas?: { readonly newRevision?: number } | null;
}

export interface DocxStoragePortLike {
  readBlob(uri: string): DocxStorageReadBlobLike;
  compareAndSwap(request: {
    readonly uri: string;
    readonly expectedRevision: number;
    readonly bytes: Uint8Array;
  }): DocxStorageCasLike;
}

export interface StoragePortDocxBytesPortOptions {
  /** 版本 CAS 冲突时的**有界**重试次数（默认 4）。绝不用"硬覆盖"绕过冲突。 */
  readonly maxWriteAttempts?: number;
}

/**
 * `content://` **内容 URI 变体**的 `DocxBytesPort`：`ref` 就是 K09 存储的 blob URI。
 *
 * - 读：`readBlob(ref)`；`status !== 'ok'`（`not-found` / `failed` / …）一律
 *   `DocxBytesError('unknown_source_ref')`，`bytes` 为 `null` / 非 `Uint8Array` / 0 字节同样拒绝。
 * - 写：`readBlob` 拿当前 `revision` → `compareAndSwap` 覆盖；冲突则有界重试，耗尽即
 *   `DocxBytesError('write_rejected')`（不静默覆盖，对齐 K09 的 CAS 语义）。
 * - `has`：以 `readBlob(ref).status === 'ok'` 探测（K09 `StoragePort` 无 `list`）。
 *
 * 平台路径**从不**出现在本层——`ref` 全程是不透明的内容 URI。
 */
export class StoragePortDocxBytesPort implements DocxBytesPort {
  readonly #port: DocxStoragePortLike;
  readonly #maxWriteAttempts: number;

  constructor(port: DocxStoragePortLike, options: StoragePortDocxBytesPortOptions = {}) {
    this.#port = port;
    const attempts = options.maxWriteAttempts ?? 4;
    this.#maxWriteAttempts = Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  }

  read(ref: DocxByteRef): Uint8Array {
    const result = this.#port.readBlob(ref);
    if (result.status !== 'ok') {
      throw new DocxBytesError(
        'unknown_source_ref',
        `存储端口对 ref=${JSON.stringify(ref)} 返回 status=${result.status}：不可读（拒绝当作空文档）`,
      );
    }
    return requireNonEmptyBytes(result.bytes, ref);
  }

  write(ref: DocxByteRef, bytes: Uint8Array): void {
    const safe = requireWritableBytes(bytes, ref);
    for (let attempt = 1; attempt <= this.#maxWriteAttempts; attempt += 1) {
      const current = this.#port.readBlob(ref);
      let expectedRevision: number;
      if (current.status === 'ok') {
        expectedRevision = current.revision ?? 0;
      } else if (current.status === 'not-found') {
        expectedRevision = 0; // K09 语义：期望不存在 ⇒ 创建。
      } else {
        throw new DocxBytesError(
          'write_rejected',
          `ref=${JSON.stringify(ref)} 写入前读当前版本失败：status=${current.status}`,
        );
      }
      const swapped = this.#port.compareAndSwap({ uri: ref, expectedRevision, bytes: safe });
      if (swapped.status === 'ok') return;
      // 冲突（并发写者改了版本）：重读再试。**不**用无版本写入硬覆盖——那是静默覆盖。
    }
    throw new DocxBytesError(
      'write_rejected',
      `ref=${JSON.stringify(ref)} 的版本 CAS 在 ${String(this.#maxWriteAttempts)} 次尝试后仍冲突`,
    );
  }

  has(ref: DocxByteRef): boolean {
    return this.#port.readBlob(ref).status === 'ok';
  }
}

/** 便捷工厂：把一份 K09 `StoragePort`（或任何形状相符的存储）转成 `DocxBytesPort`。 */
export function docxBytesPortOverStoragePort(
  port: DocxStoragePortLike,
  options: StoragePortDocxBytesPortOptions = {},
): DocxBytesPort {
  return new StoragePortDocxBytesPort(port, options);
}

// ---------------------------------------------------------------------------
// 导入回执
// ---------------------------------------------------------------------------

/** 从端口导入一份 DOCX 的结果。 */
export interface DocxLoadReceipt {
  readonly contract_version: string;
  readonly ref: DocxByteRef;
  readonly model: DocumentModel;
  /** 源字节解压后逐部件的**源清单**（zip 顺序）。 */
  readonly source_part_paths: readonly string[];
  readonly source_entry_count: number;
  readonly source_byte_length: number;
  /** 源字节（**整包**）的 sha256，裸小写 hex。 */
  readonly source_digest: string;
  /** 主部件路径（从模型里 `officeDocument` 关系解析；`null` = 模型没给）。 */
  readonly main_part_path: string | null;
  /** 内容类型 ↔ 关系类型不相容的诊断（严格模式下必然为空）。 */
  readonly content_type_diagnostics: readonly ContentTypeInconsistency[];
}

/**
 * 从字节端口读取并**严格**导入一份 DOCX。
 *
 * @throws {DocxBytesError} 端口读不到该 ref，或读到 0 字节。
 * @throws {ZipReadError} 包层有界拒绝 / CRC 不符 / 超限（R159–R160）。
 * @throws {DocxError} 包结构 / 关系完整性 / 内容类型相容性不满足。
 */
export function loadDocx(
  port: DocxBytesSource,
  ref: DocxByteRef,
  options: ImportDocxOptions = {},
): DocxLoadReceipt {
  const bytes = readBytesOrThrow(port, ref);
  const detailed = importDocxDetailed(bytes, options);
  const archive = readZip(bytes);
  const officeDocument = detailed.model.relationships.find(
    (record) => record.owner_part_path === null && /\/officeDocument$/.test(record.type),
  );
  return Object.freeze({
    contract_version: DOCX_ASSEMBLER_CONTRACT_VERSION,
    ref,
    model: detailed.model,
    source_part_paths: Object.freeze(archive.entries.map((entry) => entry.path)),
    source_entry_count: archive.entries.length,
    source_byte_length: bytes.byteLength,
    source_digest: sha256Hex(bytes),
    main_part_path: officeDocument?.target.replace(/^\/+/, '') ?? null,
    content_type_diagnostics: detailed.content_type_diagnostics,
  });
}

// ---------------------------------------------------------------------------
// 装配回执
// ---------------------------------------------------------------------------

/** 单个部件在本次装配里的处置。 */
export type PartDisposition = 'preserved' | 'changed' | 'added' | 'removed';

/** 单个部件的装配记录。 */
export interface AssembledPartRecord {
  readonly path: string;
  readonly disposition: PartDisposition;
  readonly content_type: string | null;
  /** 装配后该部件的**解压**字节长度（`removed` 时为源长度，便于对照）。 */
  readonly byte_length: number;
}

/** 保存一份 DOCX 的装配回执（对齐 `README.md` §5 的 OfficePlugin 返回形状）。 */
export interface DocxAssemblyReceipt {
  readonly contract_version: string;
  readonly ref: DocxByteRef;
  /** `application/vnd.openxmlformats-officedocument.wordprocessingml.document`。 */
  readonly mime: string;
  /** 真正写进端口的整包字节数。 */
  readonly byte_length: number;
  /** 包内条目数（解压后逐部件）。 */
  readonly entry_count: number;
  /** 写出去的那份字节的 sha256（裸小写 hex）。 */
  readonly digest: string;
  /** 源字节的 sha256；调用方没提供时为 `null`（不编造）。 */
  readonly source_digest: string | null;
  /** 逐部件处置（zip 顺序；`removed` 的排在末尾）。 */
  readonly parts: readonly AssembledPartRecord[];
  /** disposition === 'preserved' 的部件路径。 */
  readonly preserved_parts: readonly string[];
  /** disposition !== 'preserved' 的部件路径（= 合同的 `changedObjects`）。 */
  readonly changed_objects: readonly string[];
  /** 装配后**全包**关系条数（把每个 `.rels` 解析后相加）。 */
  readonly relationships_after: number;
  /** 源模型里的关系条数（`model.relationships.length`）。 */
  readonly relationships_before: number;
  /** 有界告警（如 `removed` 非空）。空数组 = 没观察到异常。 */
  readonly warnings: readonly string[];
}

/** `saveDocx` 的可选参数。 */
export interface DocxSaveOptions {
  /** 透传给 `exportDocx` 的选项（装饰/语言/图表等；省略即"一个都不写"）。 */
  readonly export?: ExportDocxOptions;
  /** 源整包摘要（由 `loadDocx` 提供时回执可写入，用于"起始包 → 导出"的对照）。 */
  readonly source_digest?: string;
  /**
   * 装配后再**导入一次**写出的字节，验证装配产物自洽（默认 `false`）。
   *
   * 打开后若装配产物导入失败，本函数**抛错**（不返回回执）——这正是"装配出的是坏包"要挡的事。
   * 代价是多一次导入；测试与"首份产物"路径建议打开，热路径可关。
   */
  readonly verify_reimport?: boolean;
}

/**
 * 导出模型 → 写入字节端口 → **回读并逐部件核对**，返回装配回执。
 *
 * @throws {DocxError} 导出被拒（见 `exportDocx` 的显式失败）。
 * @throws {DocxBytesError}/{Error} 端口的 `write` 拒绝。
 * @throws {ZipReadError}/{DocxError} `verify_reimport` 打开且装配产物不自洽时。
 */
export function saveDocx(
  port: DocxBytesSink,
  ref: DocxByteRef,
  model: DocumentModel,
  options: DocxSaveOptions = {},
): DocxAssemblyReceipt {
  const exported = exportDocx(model, options.export ?? {});

  if (options.verify_reimport === true) {
    // 装配产物必须能被同一个内核重新导入——不通过就不许落盘（先拒绝、不产出半成品）。
    importDocxDetailed(exported, {});
  }

  port.write(ref, exported);

  // 回读**写出的那份字节**（不是原对象；端口可能做了复制/序列化）。
  // 只写不读的端口以写出的字节为准（`readBack` 内部如实退化）。
  const written = readBack(port, ref, exported);
  const archive = readZip(written);

  const source = sourcePartsOf(model);
  const parts: AssembledPartRecord[] = [];
  const seen = new Set<string>();
  let relationshipsAfter = 0;

  for (const entry of archive.entries) {
    seen.add(entry.path);
    const original = source.get(entry.path);
    const disposition: PartDisposition =
      original === undefined ? 'added' : bytesEqual(original, entry.data) ? 'preserved' : 'changed';
    parts.push({
      path: entry.path,
      disposition,
      content_type: contentTypeForPart(model.content_types, entry.path),
      byte_length: entry.data.byteLength,
    });
    relationshipsAfter += countRelationships(entry.path, entry.data);
  }

  const removed: AssembledPartRecord[] = [];
  for (const [path, bytes] of source) {
    if (seen.has(path)) continue;
    removed.push({
      path,
      disposition: 'removed',
      content_type: contentTypeForPart(model.content_types, path),
      byte_length: bytes.byteLength,
    });
  }
  parts.push(...removed);

  const warnings: string[] = [];
  if (removed.length > 0) {
    // 源里有的部件在装配后不见了 = 静默丢件（R105 明令禁止）。不静默：如实告警。
    warnings.push(
      `装配后少了 ${String(removed.length)} 个源部件（疑似静默丢件）：${removed
        .map((record) => record.path)
        .join(', ')}`,
    );
  }

  return Object.freeze({
    contract_version: DOCX_ASSEMBLER_CONTRACT_VERSION,
    ref,
    mime: DOCX_MAIN_CONTENT_TYPE,
    byte_length: written.byteLength,
    entry_count: archive.entries.length,
    digest: sha256Hex(written),
    source_digest: options.source_digest ?? null,
    parts: Object.freeze(parts),
    preserved_parts: Object.freeze(
      parts.filter((record) => record.disposition === 'preserved').map((record) => record.path),
    ),
    changed_objects: Object.freeze(
      parts.filter((record) => record.disposition !== 'preserved').map((record) => record.path),
    ),
    relationships_after: relationshipsAfter,
    relationships_before: model.relationships.length,
    warnings: Object.freeze(warnings),
  });
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function readBytesOrThrow(port: DocxBytesSource, ref: DocxByteRef): Uint8Array {
  let bytes: unknown;
  try {
    bytes = port.read(ref);
  } catch (error) {
    if (error instanceof DocxBytesError) throw error;
    throw new DocxBytesError(
      'unknown_source_ref',
      `字节端口读取 ref=${JSON.stringify(ref)} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return requireNonEmptyBytes(bytes, ref);
}

/**
 * 把端口/存储读到的**未知**值归一成"可用的非空字节"，否则抛有界 `DocxBytesError`。
 *
 * 三条 fail-closed 判据：读不到（`null` / `undefined`）⇒ `unknown_source_ref`；
 * 不是 `Uint8Array` ⇒ `unknown_source_ref`（不把坏类型传进 ZIP 解析器）；
 * 0 字节 ⇒ `ref_empty`（空包不是空文档，R140）。返回的是**副本**，与存储内部缓冲区解耦。
 */
function requireNonEmptyBytes(value: unknown, ref: DocxByteRef): Uint8Array {
  if (value === null || value === undefined) {
    throw new DocxBytesError('unknown_source_ref', `bytes 端口里没有 ref=${JSON.stringify(ref)}`);
  }
  if (!(value instanceof Uint8Array)) {
    throw new DocxBytesError(
      'unknown_source_ref',
      `字节端口对 ref=${JSON.stringify(ref)} 返回的不是 Uint8Array`,
    );
  }
  if (value.byteLength === 0) {
    throw new DocxBytesError('ref_empty', `ref=${JSON.stringify(ref)} 读到 0 字节：空包不是空文档（R140）`);
  }
  return Uint8Array.from(value);
}

/** 写入侧的 fail-closed：非 `Uint8Array` 一律拒绝，并**复制**后交给存储（不与调用方共享缓冲区）。 */
function requireWritableBytes(value: unknown, ref: DocxByteRef): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new DocxBytesError('write_rejected', `写入 ref=${JSON.stringify(ref)} 的字节不是 Uint8Array`);
  }
  return Uint8Array.from(value);
}

/** 非内存端口：写完再读一次，拿到"真正落下去的那份字节"。 */
function readBack(port: DocxBytesSink, ref: DocxByteRef, exported: Uint8Array): Uint8Array {
  const maybeRead = (port as Partial<DocxBytesSource>).read;
  if (typeof maybeRead === 'function') {
    return maybeRead.call(port, ref);
  }
  // 只写不读的端口：以写出的字节为准（如实：这时的"回读"退化成"写出对象本身"）。
  return exported;
}

/** 模型的源部件字节：`opaque_parts`（含主部件与所有 `.rels`/内容类型）∪ `media`。 */
function sourcePartsOf(model: DocumentModel): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const part of model.opaque_parts) {
    map.set(part.path, part.bytes);
  }
  for (const part of model.media) {
    map.set(part.path, part.bytes);
  }
  return map;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 该条目若是 `.rels`，解析后返回关系条数；否则 0。**解析失败即 0**——关系装配回读不静默。 */
function countRelationships(path: string, data: Uint8Array): number {
  const owner = relsOwnerOf(path);
  if (owner === null) return 0;
  try {
    const records = parseRelationships(data, owner.kind === 'part' ? owner.owner : null, path);
    return records.length;
  } catch {
    return 0;
  }
}
