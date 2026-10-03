/**
 * **X-R01**：外部 Excel / WPS 语料、格式与关系保真回归 —— 操作 schema 与类型。
 *
 * 本包是 Excel 线的**备用/回归包**（见 `docs/other/ds-six-lanes-2026-10-03/EXCEL.md` 备用包表
 * 的 X-R01 行）：它不实现新的读写能力，而是把"一份外部产出方形态的工作簿，经导入 → 导出 →
 * 重导入之后，模型、未知部件字节、关系声明是否仍然一致"固化成**可复算的判据**。
 *
 * ## 诚实边界（先读这段再看类型）
 *
 * 仓库里**没有**真实 Excel / WPS 产出的 .xlsx 二进制。本包随附的语料是**产出方形态的模拟夹具**
 * （`provenance: 'excel-emulation' | 'wps-emulation'`）——它们复刻外部文件的结构特征
 * （docProps、theme、calcChain、工作表级 `_rels`、Default 扩展名内容类型、外部关系、
 * 共享字符串、共享公式、日期样式……），但**不是**真实软件写出的字节。因此本包证据到达的层是
 * `unit` / `contract`，**不是** `consumer-reopen`（未在真实 Excel/WPS 里打开验证）。
 * 一个 `external-file` 装载入口已就绪：把真实外部文件放进语料目录即可纳入同一套回归（见 RUNBOOK）。
 *
 * ## 判据（每一条都对应一个 {@link FidelityInvariant}）
 *
 * 1. `import.ok` / `import.rejects` —— 能读的读得进，该拒的按预期类型拒；
 * 2. `export.ok` / `reread.ok` —— 导出、重导入都不抛；
 * 3. `model.stable` —— 重导入后的模型与首读模型**逐格一致**；
 * 4. `parts.byte-identical` —— 首读登记为"未知部件"的每一份字节，在导出包里**逐字节相同**；
 * 5. `parts.stable-across-reread` —— 未知部件**清单**在重导入后不变（不多不少）；
 * 6. `relationships.accounted` —— 首读登记的每条关系声明，要么在重导入后仍在，要么被**显式登记为丢弃**；
 * 7. `dropped.subset` —— 被丢弃的关系**只能**来自首读登记过的那批（不得凭空丢）；
 * 8. `deterministic` —— 同一模型 + 同一残留写两遍，摘要相同；
 * 9. `content-type.resolved` —— 每个保留部件的内容类型都被解析出来了（不是 octet-stream 兜底）。
 */

/** 语料的来源形态。 */
export type CorpusProvenance =
  /** 复刻 Excel 产出方结构（docProps / theme / calcChain / sheet 级 rels 等）。 */
  | 'excel-emulation'
  /** 复刻 WPS 产出方结构（Default 扩展名内容类型、custom 属性等）。 */
  | 'wps-emulation'
  /** 反向夹具：损坏 / 不支持的输入，必须被准确拒绝。 */
  | 'negative-fixture'
  /** 从磁盘装载的真实外部文件（provenance 由装载入口标记）。 */
  | 'external-file';

/** 导入阶段的期望：`ok` = 应当读进来；`{ throws }` = 应当以某类错误拒绝。 */
export type ExpectedImport =
  | 'ok'
  | {
      /** `zip` = 容器层错误（`ZipReadError`）；`validation` = 结构/内容层错误（`ValidationError`）。 */
      readonly throws: 'zip' | 'validation' | 'any';
    };

/** 一条语料。 */
export interface CorpusEntry {
  readonly id: string;
  readonly provenance: CorpusProvenance;
  readonly description: string;
  /** 真实 ZIP 容器字节（可写盘的真实 .xlsx）。 */
  readonly bytes: Uint8Array;
  readonly expected_import: ExpectedImport;
  /**
   * 首读后**必须**登记为未知部件、且在导出包里**逐字节保留**的路径（升序）。
   * 缺省 = 不检查这条（例如纯负向夹具）。
   */
  readonly expected_preserved_parts?: readonly string[];
  /**
   * 首读后登记为保留部件的路径 → 期望被解析出的内容类型。
   * 用来抓"内容类型解析退化到 octet-stream"这类静默降级。
   */
  readonly expected_content_types?: Readonly<Record<string, string>>;
}

/** 回归判据的封闭枚举。 */
export type FidelityInvariant =
  | 'import.ok'
  | 'import.rejects'
  | 'export.ok'
  | 'reread.ok'
  | 'model.stable'
  | 'parts.byte-identical'
  | 'parts.stable-across-reread'
  | 'relationships.accounted'
  | 'dropped.subset'
  | 'deterministic'
  | 'content-type.resolved';

/** 一条违例（判据 + 人可读细节）。 */
export interface FidelityViolation {
  readonly entry_id: string;
  readonly invariant: FidelityInvariant;
  readonly detail: string;
}

/** 单条语料的回归结果。 */
export interface EntryReport {
  readonly id: string;
  readonly provenance: CorpusProvenance;
  /** 该条是否零违例。 */
  readonly ok: boolean;
  readonly import_status: 'ok' | 'rejected' | 'error';
  /** 导入被拒时的错误名（`ZipReadError` / `ValidationError` / 其它）。 */
  readonly import_error?: string;
  /** 源字节 sha256（裸小写十六进制）。 */
  readonly source_digest: string;
  /** 导出字节 sha256（导入被拒时为 `null`）。 */
  readonly exported_digest: string | null;
  /** 首读登记的未知部件路径（升序）。 */
  readonly preserved_parts: readonly string[];
  /** 期望保留却在首读里缺失的部件路径。 */
  readonly missing_preserved_parts: readonly string[];
  /** 保留部件在导出包里字节不一致的路径。 */
  readonly byte_mismatch_parts: readonly string[];
  /** 导出时被显式登记丢弃的关系（原文）。 */
  readonly dropped_relationships: readonly string[];
  /** 重导入后登记的关系声明描述符（升序，便于对照）。 */
  readonly relationships_out: readonly string[];
  readonly violations: readonly FidelityViolation[];
}

/** 整批回归报告。 */
export interface FidelityReport {
  readonly corpus_size: number;
  readonly entries: readonly EntryReport[];
  readonly violations: readonly FidelityViolation[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
  };
}
