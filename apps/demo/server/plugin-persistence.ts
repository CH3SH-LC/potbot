/**
 * FA-PLG-PERSIST-PORT：模板平台**真实落盘**的安装状态端口。
 *
 * `src/plugins/install-sources.ts` 把安装 / 启用 / 停用 / 卸载接到一个可替换的
 * `InstallStateStore` 上，但那里**只给了内存实现**（`createMemoryInstallStateStore`）。
 * 本文件补上**文件介质**的那一半：把 `PluginRegistrySnapshot`（外加版本冻结绑定、
 * 包声明）真正写到运行目录下的一个文件里，并让**新实例**能读回同样的状态。
 *
 * ## 这个端口解决的四件事（每件都有反向对照）
 *
 * 1. **原子写**：先写同目录临时文件 → `fsync` → `rename` 覆盖目标，读方**永远不会**
 *    看到半截 JSON。反向对照：一次成功 `save()` 后目录里**不留**任何 `.tmp-*` 残留。
 * 2. **损坏文件 ⇒ 拒绝加载**（具名原因 `corrupt_json` / `invalid_snapshot`）。
 *    **绝不**把解析失败当成"什么都没装"返回空——那会让用户已装好的模板**静默消失**。
 *    反向对照：文件不存在 ⇒ `undefined`（合法的"还没有状态"）；文件存在但坏 ⇒ **抛错**。
 * 3. **凭据 / 密钥不落盘**：任何键名命中 `SECRET_KEY_PATTERN`（token / secret / password /
 *    api_key / credential …）的字段，**写盘前剔除**，并把**被剔除的字段路径逐条记名**到
 *    `redacted_keys`。反向对照：原始文件文本里**搜不到**密钥值，也搜不到那些键名。
 * 4. **并发写不互相覆盖**：每个写入者带 `writerId`，落盘带 `generation` 代数。写入前比对
 *    "我最后读到的代数"与"磁盘上的代数"，不一致 ⇒ 抛 `write_conflict` 并**拒绝覆盖**。
 *    反向对照：先 `load()` 再 `save()` 的接力写入（A 写 → B 读 → B 写）**不**误报冲突。
 * 5. **暂存值随下次 `save()` 落盘**：`recordBinding()` / `saveBindings()` /
 *    `setPackageDeclarations()` 只暂存在内存里，由**下一次 `save()`** 写入文件——
 *    **目标文件已存在时同样成立**。反向对照：本实例**没**暂存过时，`save()` 用的是磁盘上
 *    已有的绑定 / 声明（不凭空清空）。
 *    > 本项是**回归修复**：`save()` 内部会先 `readState()` 做代数检查，而 `readState()` 在
 *    > 文件已存在时会把缓存刷成磁盘当前值——早先版本因此在写 payload 时读到了**磁盘旧值**，
 *    > 使"暂存 ⇒ 随下次 `save()` 落盘"这条契约在**第二次及之后**的写入上静默失效
 *    > （绑定 / 声明被丢弃；文件不存在时不触发，故第 1 节的往返用例照不到）。
 *    > 修复：`save()` 先抓下暂存值，写盘用暂存值，写完把缓存对齐到刚写下的内容。
 *
 * ## 本文件的确切边界（不编造）
 *
 * - **仅本进程内的两个实例**同时写入冲突检测已验证；**未做真实跨进程**（两个操作系统进程
 *   同时打开同一文件）的验证。冲突检测是**乐观式**的（读-比-写），能检出**顺序交错**的
 *   覆盖，但两个进程在同一微秒各自读第 N 代再各自 rename，仍可能"后写者胜"——这是已知残留
 *   竞态，本端口不宣称提供了操作系统级文件锁。
 * - 原子性依赖"同目录 rename"，在**同一文件系统**内成立；跨卷 rename 不保证原子。
 * - 本端口是**新增端口**，未接线到 `http.ts` / `main.ts` / `plugin-routes.ts`：接线由
 *   总协调者统一处理，本文件不改任何既有文件。
 *
 * 时间由注入的 `now` 提供（默认墙钟），`writerId` 由调用方给出（默认含 `process.pid`）——
 * 便于测试注入确定值。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { asLogicalTime, type LogicalTime } from '../../../src/protocol/index.js';
import type {
  InstallStateStore,
  PluginBinding,
  PluginInstallRecord,
  PluginRegistrySnapshot,
} from '../../../src/plugins/index.js';

// ---------------------------------------------------------------------------
// 常量与失败码
// ---------------------------------------------------------------------------

/** 落盘格式的标识（写进文件，读回时核对；认不出就拒载）。 */
export const PLUGIN_PERSISTENCE_SCHEMA = 'potbot.plugin-install-state';

/** 落盘格式版本。不认识的版本 ⇒ `unsupported_schema`，不猜、不降级。 */
export const PLUGIN_PERSISTENCE_SCHEMA_VERSION = 1;

/** 默认文件名（放在调用方给的运行目录下）。 */
export const DEFAULT_INSTALL_STATE_FILE = 'plugin-install-state.json';

/** 临时文件前缀（原子写的中转文件；正常一次 `save()` 后不应残留）。 */
export const TEMP_FILE_MARKER = '.tmp-';

/** 具名失败码（每一条都对应一个可指认的拒绝原因）。 */
export const PLUGIN_PERSISTENCE_FAILURE_CODES = [
  'corrupt_json', // 文件存在但不是合法 JSON（截断 / 空文件 / 乱码）
  'invalid_snapshot', // JSON 合法但形状不是本端口的快照
  'invalid_binding', // 版本冻结绑定的形状非法
  'unsupported_schema', // schema / 版本号不是本端口认识的
  'write_conflict', // 并发写：磁盘已被别的写入者推进，拒绝覆盖
  'path_is_directory', // 目标路径是目录
  'io_error', // 文件系统读写失败
] as const;
export type PluginPersistenceFailureCode = (typeof PLUGIN_PERSISTENCE_FAILURE_CODES)[number];

/** 具名持久化错误：**永远**带 `code` 与目标路径，调用方可逐条处置，不靠猜。 */
export class PluginPersistenceError extends Error {
  readonly code: PluginPersistenceFailureCode;
  readonly path: string;
  readonly detail: string;

  constructor(code: PluginPersistenceFailureCode, path: string, detail: string) {
    super(`[${code}] ${detail}（${path}）`);
    this.name = 'PluginPersistenceError';
    this.code = code;
    this.path = path;
    this.detail = detail;
    Object.setPrototypeOf(this, PluginPersistenceError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 凭据剔除（落盘前；键名命中即剔除并记名）
// ---------------------------------------------------------------------------

/**
 * **凭据键名**判定式。命中即按"敏感字段"处理：值不落盘，键名进 `redacted_keys`。
 * 刻意**按键名**（不是按值）判定：值可能恰好是普通文本，键名才表达"这是凭据"的意图。
 */
export const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|passphrase|bearer|authorization|cookie/i;

export interface RedactionResult {
  /** 剔除敏感字段后的深拷贝。 */
  readonly value: unknown;
  /** 被剔除字段的**点分路径**（逐条具名；无剔除时为空数组）。 */
  readonly redacted_keys: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深度遍历并**剔除**键名命中 `SECRET_KEY_PATTERN` 的字段，返回剔除后的值与**被剔除的路径清单**。
 * 数组按 `[i]` 编号；对象按下标 `.` 连接。
 */
export function redactSecrets(value: unknown, prefix = ''): RedactionResult {
  const redacted: string[] = [];

  const walk = (node: unknown, nodePath: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((entry, index) => walk(entry, `${nodePath}[${index}]`));
    }
    if (!isPlainObject(node)) {
      return node;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      const childPath = nodePath.length === 0 ? key : `${nodePath}.${key}`;
      if (SECRET_KEY_PATTERN.test(key)) {
        redacted.push(childPath);
        continue;
      }
      out[key] = walk(child, childPath);
    }
    return out;
  };

  const result = walk(value, prefix);
  return Object.freeze({ value: result, redacted_keys: Object.freeze(redacted) });
}

// ---------------------------------------------------------------------------
// 落盘信封（比 PluginRegistrySnapshot 多带绑定 / 声明 / 代数 / 写入者）
// ---------------------------------------------------------------------------

/**
 * 磁盘上的完整状态。`snapshot` 直接复用 `PluginRegistrySnapshot`（可喂给
 * `InstallSourceManager.reload()`）；`bindings` 承载**版本冻结绑定**——
 * 注册表快照里**不含**绑定，若不同时落盘就做不到"冻结绑定也读回一致"。
 */
export interface PersistedPluginInstallState {
  readonly schema: string;
  readonly schema_version: number;
  /** 代数（每次成功写入 +1；并发冲突检测的依据）。 */
  readonly generation: number;
  readonly written_at: LogicalTime;
  readonly last_writer: string;
  readonly snapshot: PluginRegistrySnapshot;
  /** 版本冻结绑定（R230：执行中途不改规则）。 */
  readonly bindings: readonly PluginBinding[];
  /** 调用方要求一并记住的包声明（**已剔除凭据**）。 */
  readonly package_declarations: Readonly<Record<string, unknown>>;
  /** 写盘时被剔除的敏感字段路径（逐条具名）。 */
  readonly redacted_keys: readonly string[];
}

// ---------------------------------------------------------------------------
// 形状校验（拒载损坏文件的判据）
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验一条安装记录；返回 `null` 表示通过，否则返回**具名原因**。 */
function validateInstallRecord(raw: unknown, index: number): string | null {
  if (!isPlainObject(raw)) {
    return `records[${index}] 不是对象`;
  }
  if (!isNonEmptyString(raw.plugin_id)) {
    return `records[${index}].plugin_id 缺失或非字符串`;
  }
  if (typeof raw.version !== 'string') {
    return `records[${index}].version 非字符串`;
  }
  for (const field of ['installed', 'enabled', 'authorized'] as const) {
    if (typeof raw[field] !== 'boolean') {
      return `records[${index}].${field} 非布尔`;
    }
  }
  if (!isPlainObject(raw.install_source)) {
    return `records[${index}].install_source 非对象`;
  }
  if (!isNonEmptyString(raw.install_source.kind)) {
    return `records[${index}].install_source.kind 缺失`;
  }
  if (typeof raw.install_source.origin !== 'string') {
    return `records[${index}].install_source.origin 非字符串`;
  }
  for (const field of ['installed_at', 'updated_at'] as const) {
    if (!isFiniteNumber(raw[field])) {
      return `records[${index}].${field} 非有限数字`;
    }
  }
  return null;
}

/** 校验一个版本冻结绑定；返回 `null` 表示通过。 */
function validateBinding(raw: unknown, index: number): string | null {
  if (!isPlainObject(raw)) {
    return `bindings[${index}] 不是对象`;
  }
  if (!isNonEmptyString(raw.plugin_id)) {
    return `bindings[${index}].plugin_id 缺失`;
  }
  if (typeof raw.version !== 'string') {
    return `bindings[${index}].version 非字符串`;
  }
  if (!Array.isArray(raw.capability_ids) || !raw.capability_ids.every((id) => typeof id === 'string')) {
    return `bindings[${index}].capability_ids 非字符串数组`;
  }
  if (!isFiniteNumber(raw.pinned_at)) {
    return `bindings[${index}].pinned_at 非有限数字`;
  }
  return null;
}

/** 校验一个快照（`records` + `revision`）。 */
function validateSnapshot(raw: unknown): string | null {
  if (!isPlainObject(raw)) {
    return 'snapshot 不是对象';
  }
  if (!Array.isArray(raw.records)) {
    return 'snapshot.records 不是数组';
  }
  if (!isFiniteNumber(raw.revision)) {
    return 'snapshot.revision 非有限数字';
  }
  for (let index = 0; index < raw.records.length; index += 1) {
    const problem = validateInstallRecord(raw.records[index], index);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/**
 * 解析磁盘文本为落盘信封。**任何一步失败都抛具名 `PluginPersistenceError`**——
 * 绝不返回 `undefined`（那会被上层当成"什么都没装"）。
 */
export function parsePersistedInstallState(text: string, filePath: string): PersistedPluginInstallState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PluginPersistenceError(
      'corrupt_json',
      filePath,
      `安装状态文件不是合法 JSON，拒绝加载（不当作"什么都没装"）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new PluginPersistenceError('corrupt_json', filePath, '安装状态文件顶层不是 JSON 对象，拒绝加载');
  }
  if (raw.schema !== PLUGIN_PERSISTENCE_SCHEMA) {
    throw new PluginPersistenceError(
      'invalid_snapshot',
      filePath,
      `schema 不是 ${PLUGIN_PERSISTENCE_SCHEMA}（实际 ${JSON.stringify(raw.schema)}），拒绝加载`,
    );
  }
  if (raw.schema_version !== PLUGIN_PERSISTENCE_SCHEMA_VERSION) {
    throw new PluginPersistenceError(
      'unsupported_schema',
      filePath,
      `schema_version ${JSON.stringify(raw.schema_version)} 不受支持（本端口只认 ${PLUGIN_PERSISTENCE_SCHEMA_VERSION}）`,
    );
  }
  const snapshotProblem = validateSnapshot(raw.snapshot);
  if (snapshotProblem !== null) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, `快照形状非法：${snapshotProblem}`);
  }
  if (!Array.isArray(raw.bindings)) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, 'bindings 不是数组');
  }
  for (let index = 0; index < raw.bindings.length; index += 1) {
    const problem = validateBinding(raw.bindings[index], index);
    if (problem !== null) {
      throw new PluginPersistenceError('invalid_binding', filePath, `版本冻结绑定形状非法：${problem}`);
    }
  }
  if (!isPlainObject(raw.package_declarations)) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, 'package_declarations 不是对象');
  }
  if (!Array.isArray(raw.redacted_keys) || !raw.redacted_keys.every((key) => typeof key === 'string')) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, 'redacted_keys 非字符串数组');
  }
  if (!isFiniteNumber(raw.generation) || raw.generation < 0) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, 'generation 非非负有限数字');
  }
  if (!isNonEmptyString(raw.last_writer)) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, 'last_writer 缺失');
  }
  if (!isFiniteNumber(raw.written_at)) {
    throw new PluginPersistenceError('invalid_snapshot', filePath, 'written_at 非有限数字');
  }
  return Object.freeze({
    schema: PLUGIN_PERSISTENCE_SCHEMA,
    schema_version: PLUGIN_PERSISTENCE_SCHEMA_VERSION,
    generation: raw.generation,
    written_at: raw.written_at as LogicalTime,
    last_writer: raw.last_writer,
    snapshot: Object.freeze({
      records: Object.freeze((raw.snapshot as { records: PluginInstallRecord[] }).records),
      revision: (raw.snapshot as { revision: number }).revision,
    }),
    bindings: Object.freeze((raw.bindings as PluginBinding[]).slice()),
    package_declarations: Object.freeze({ ...(raw.package_declarations as Record<string, unknown>) }),
    redacted_keys: Object.freeze((raw.redacted_keys as string[]).slice()),
  });
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

let tempFileCounter = 0;

function sanitizeForFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * **原子写**：同目录临时文件 → `fsync` → `rename` 覆盖目标。
 *
 * 读方**永远不会**看到半截 JSON：`rename` 在同一文件系统内是原子的，要么旧内容、要么新内容。
 * 失败时清理临时文件，目标文件保持原样（不会被写坏）。
 */
export function atomicWriteText(filePath: string, text: string, writerId = 'w'): void {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new PluginPersistenceError('io_error', filePath, `无法创建运行目录：${messageOf(error)}`);
  }
  tempFileCounter += 1;
  const tempPath = `${filePath}${TEMP_FILE_MARKER}${sanitizeForFileName(writerId)}-${tempFileCounter}`;

  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'w');
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 忽略：下面统一清理 */
      }
      fd = null;
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* 忽略：尽力清理 */
    }
    throw new PluginPersistenceError('io_error', filePath, `写临时文件失败：${messageOf(error)}`);
  }
  try {
    closeSync(fd);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* 忽略 */
    }
    throw new PluginPersistenceError('io_error', filePath, `关闭临时文件失败：${messageOf(error)}`);
  }

  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* 忽略 */
    }
    throw new PluginPersistenceError('io_error', filePath, `原子替换失败：${messageOf(error)}`);
  }

  // 尽力 fsync 目录（POSIX 上让 rename 持久；Windows 打开目录会失败，忽略）。
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* 平台不支持目录 fsync：忽略，不影响功能正确性 */
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 文件安装状态端口
// ---------------------------------------------------------------------------

export interface FileInstallStateStoreOptions {
  /** 运行目录（文件落在这里）。 */
  readonly dir: string;
  /** 文件名；默认 `plugin-install-state.json`。 */
  readonly fileName?: string;
  /** 写入者标识（并发冲突检测用）；默认含 `process.pid`。 */
  readonly writerId?: string;
  /** 逻辑时钟；默认墙钟。测试注入确定值。 */
  readonly now?: () => LogicalTime;
}

/** 解析安装状态文件的完整路径（供装配处与测试使用）。 */
export function resolveInstallStatePath(dir: string, fileName: string = DEFAULT_INSTALL_STATE_FILE): string {
  return join(dir, fileName);
}

/** 列出目录里残留的原子写临时文件（正常应为空；供测试与运维自检）。 */
export function listStaleTempFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) {
    return Object.freeze([]);
  }
  return Object.freeze(readdirSync(dir).filter((name) => name.includes(TEMP_FILE_MARKER)));
}

/**
 * **文件落盘的安装状态端口**。实现 `InstallStateStore`，可直接喂给
 * `createInstallSourceManager({ store })`，让 `persist()` / `reload()` 落到真实文件。
 *
 * 额外承载注册表快照**装不下**的两样东西：版本冻结绑定与包声明（凭据已剔除）。
 */
export class FileInstallStateStore implements InstallStateStore {
  /** 目标文件路径（只读；便于装配与诊断）。 */
  readonly filePath: string;
  private readonly writerId: string;
  private readonly now: () => LogicalTime;
  /** 本实例最后读到的磁盘代数；`null` = 从未读到过（文件不存在或从未 load）。 */
  private observedGeneration: number | null = null;
  private bindings: readonly PluginBinding[] = Object.freeze([]);
  private declarations: Readonly<Record<string, unknown>> = Object.freeze({});
  private redactedKeys: readonly string[] = Object.freeze([]);

  constructor(options: FileInstallStateStoreOptions) {
    this.filePath = resolveInstallStatePath(options.dir, options.fileName);
    this.writerId = options.writerId ?? `pid-${process.pid}`;
    this.now = options.now ?? ((): LogicalTime => asLogicalTime(Date.now()));
  }

  /** 本实例的写入者标识。 */
  get writer(): string {
    return this.writerId;
  }

  /** 本实例最后读到的磁盘代数（`null` = 尚无可读状态）。 */
  get generation(): number | null {
    return this.observedGeneration;
  }

  /** 当前暂存、待随下次 `save()` 落盘的版本冻结绑定。 */
  get pendingBindings(): readonly PluginBinding[] {
    return this.bindings;
  }

  /** 当前暂存的包声明（内存里是剔除前的原值；落盘时才剔除）。 */
  get pendingDeclarations(): Readonly<Record<string, unknown>> {
    return this.declarations;
  }

  /** 上一次 `load()` / `save()` 时被剔除的敏感字段路径。 */
  get lastRedactedKeys(): readonly string[] {
    return this.redactedKeys;
  }

  /**
   * 读取底层文件并同步本实例缓存。文件不存在 ⇒ `undefined`（合法的"还没有状态"）；
   * 文件存在但损坏 ⇒ **抛 `PluginPersistenceError`**，绝不当作空。
   *
   * **注意**：文件已存在时，本方法会把磁盘上的 `bindings` / `declarations` **采纳为**本实例
   * 当前的暂存值（`load()` / `loadAll()` 的"读回即刷新"语义）。因此 `save()` **不能**在调用它
   * 之后再去读 `this.bindings` 当 payload——那正是"暂存绑定在文件已存在时被静默丢弃"的成因。
   */
  private readState(): PersistedPluginInstallState | undefined {
    if (!existsSync(this.filePath)) {
      this.observedGeneration = null;
      return undefined;
    }
    let stats;
    try {
      stats = statSync(this.filePath);
    } catch (error) {
      throw new PluginPersistenceError('io_error', this.filePath, `无法读取文件属性：${messageOf(error)}`);
    }
    if (stats.isDirectory()) {
      throw new PluginPersistenceError('path_is_directory', this.filePath, '安装状态路径是目录，不是文件');
    }
    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      throw new PluginPersistenceError('io_error', this.filePath, `读取安装状态失败：${messageOf(error)}`);
    }
    const envelope = parsePersistedInstallState(text, this.filePath);
    this.observedGeneration = envelope.generation;
    this.bindings = envelope.bindings;
    this.declarations = envelope.package_declarations;
    this.redactedKeys = envelope.redacted_keys;
    return envelope;
  }

  /** 读回注册表快照（`InstallStateStore` 的口）。损坏文件抛错，见 `readState`。 */
  load(): PluginRegistrySnapshot | undefined {
    return this.readState()?.snapshot;
  }

  /** 读回完整信封（含绑定 / 声明 / 代数）。 */
  loadAll(): PersistedPluginInstallState | undefined {
    return this.readState();
  }

  /** 暂存一个版本冻结绑定，随下次 `save()` 落盘（同一 `plugin_id` 覆盖旧值）。 */
  recordBinding(binding: PluginBinding): void {
    const problem = validateBinding(binding, 0);
    if (problem !== null) {
      throw new PluginPersistenceError('invalid_binding', this.filePath, `拒绝记录非法绑定：${problem}`);
    }
    this.bindings = Object.freeze([
      ...this.bindings.filter((existing) => existing.plugin_id !== binding.plugin_id),
      Object.freeze({ ...binding, capability_ids: Object.freeze([...binding.capability_ids]) }),
    ]);
  }

  /** 整体替换待落盘的版本冻结绑定。 */
  saveBindings(bindings: readonly PluginBinding[]): void {
    for (let index = 0; index < bindings.length; index += 1) {
      const problem = validateBinding(bindings[index], index);
      if (problem !== null) {
        throw new PluginPersistenceError('invalid_binding', this.filePath, `拒绝记录非法绑定：${problem}`);
      }
    }
    this.bindings = Object.freeze(bindings.map((binding) => Object.freeze({ ...binding })));
  }

  /** 暂存包声明（落盘时剔除凭据并记名）。 */
  setPackageDeclarations(declarations: Readonly<Record<string, unknown>>): void {
    this.declarations = Object.freeze({ ...declarations });
  }

  /**
   * 把快照（连同暂存的绑定与声明）**原子**写入文件。
   *
   * 并发保护：写入前比对"本实例最后读到的代数"与"磁盘上的代数"。不符 ⇒ 抛
   * `write_conflict` 并**拒绝覆盖**（既不写、也不静默丢别人的数据）。
   * 目标文件损坏 ⇒ 抛 `corrupt_json`（不覆盖损坏文件，避免掩盖问题）。
   *
   * **暂存值优先**：`bindings` / `package_declarations` 用本实例暂存的值落盘（见
   * {@link recordBinding} / {@link saveBindings} / {@link setPackageDeclarations}）——
   * **文件已存在时同样落盘**。未暂存过的实例写一个已存在的文件会在代数检查处抛
   * `write_conflict`（`observedGeneration === null` ≠ 磁盘代数），因此不存在"没暂存却把磁盘
   * 绑定清空"的路径；`load()` / `loadAll()` 之后的写入沿用读回的值，行为与修复前一致。
   */
  save(snapshot: PluginRegistrySnapshot): void {
    const problems = validateSnapshot(snapshot);
    if (problems !== null) {
      throw new PluginPersistenceError('invalid_snapshot', this.filePath, `拒绝写入非法快照：${problems}`);
    }
    // 必须在 readState() 之前抓下暂存值与"我上次读到的代数"——
    // readState() 会把缓存刷新成磁盘当前值（这正是本方法要避开的那一步）。
    const previouslyObserved = this.observedGeneration;
    const pendingBindings = this.bindings;
    const pendingDeclarations = this.declarations;
    const disk = this.readState(); // 损坏会在此抛出，从而拒绝覆盖
    const diskGeneration = disk?.generation ?? 0;
    if (disk !== undefined && previouslyObserved !== diskGeneration) {
      throw new PluginPersistenceError(
        'write_conflict',
        this.filePath,
        `磁盘状态已被 ${disk.last_writer} 推进到第 ${diskGeneration} 代，` +
          `本写入者（${this.writerId}）最后读到的是 ${
            previouslyObserved === null ? '（从未读取）' : `第 ${previouslyObserved} 代`
          }：拒绝覆盖`,
      );
    }

    const payload = {
      schema: PLUGIN_PERSISTENCE_SCHEMA,
      schema_version: PLUGIN_PERSISTENCE_SCHEMA_VERSION,
      generation: diskGeneration + 1,
      written_at: this.now(),
      last_writer: this.writerId,
      snapshot,
      // 用**暂存值**（readState() 之前抓下的），而不是 this.bindings——
      // 后者在文件已存在时已被 readState() 覆盖成磁盘旧值，会让暂存值被静默丢弃。
      bindings: pendingBindings,
      package_declarations: pendingDeclarations,
    };
    const redaction = redactSecrets(payload);
    const body = redaction.value as Record<string, unknown>;
    // 快照 / 绑定的键名是固定形状，不可能命中敏感键名模式；剔除只会发生在声明里。
    const envelope = { ...body, redacted_keys: redaction.redacted_keys };

    atomicWriteText(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`, this.writerId);
    this.observedGeneration = diskGeneration + 1;
    // 写完后缓存对齐到**刚写下的内容**：纠正 readState() 造成的"内存暂存值被磁盘旧值顶掉"。
    this.bindings = pendingBindings;
    this.declarations = pendingDeclarations;
    this.redactedKeys = redaction.redacted_keys;
  }
}

/** 构造一个文件落盘的安装状态端口。 */
export function createFileInstallStateStore(options: FileInstallStateStoreOptions): FileInstallStateStore {
  return new FileInstallStateStore(options);
}
