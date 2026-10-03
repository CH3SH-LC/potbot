/**
 * **冻结点标识的单一来源**（D11 收尾；合同 R24 / `guide:111`）。
 *
 * ## 为什么要有这个文件
 *
 * D10 的独立复核发现：四个验收夹具（`a02a03/harness.ts`、`a04/harness.ts`、
 * `a05/scenario-support.ts`、`p4/scenario-support.ts`）**各自硬编码**了冻结点标识
 * （`45c1d40c…` + 字符串 `'FREEZE-1'`），并把它们回写进全部证据 JSON。
 * 那三条断言翻转发生在 D03 修复**之后**，因此那批证据自称 FREEZE-1、实际被测的却是
 * FREEZE-2 的源码——按 R24「更早冻结点记录不能替代当前集成结果」，不能直接充当结论。
 *
 * 本模块把冻结点标识收成**一处**：四个夹具一律从这里取，不再各自硬编码。
 *
 * ## 为什么标识值存在 **JSON**（而非本文件里的常量）
 *
 * 摘要域是 `find src tests -name "*.ts"`。若把摘要写进 `.ts` 常量，本文件自身的字节
 * 也在这个域里——**写下摘要**这一动作本身就会改变摘要，恒等式无解（自指）。
 * 因此标识值落在 `docs/other/evidence/D11/freeze-identity.json`（非 `.ts`，不在摘要域内），
 * 本模块只负责**读取 + 自检 + 出口**。这样交付时报告的摘要与任何人对同一工作区
 * 重跑 `find src tests -name "*.ts" | sort | xargs sha256sum | sha256sum` 得到的值**必然相等**。
 *
 * ## 自查（自检入口）
 *
 * `assertFreezeIdentity()` 校验标识的形状与自洽性，**并把"是不是已经作废的冻结点"
 * 当作硬失败**——这正是 D10 找到的那类事故（证据引用了被取代的冻结点）的机器判据。
 * 任一夹具模块在被 import 时即执行一次自检（见文件末尾），所以引用旧标识的代码
 * 会在**加载期**就炸，而不是悄悄写出一份自称过期的证据。
 *
 * ---------------------------------------------------------------------------
 * ## F11：摘要校验必须绑定**真实文件内容**（合同 R38.1–R38.4）
 *
 * 上述加载期自检只验**形状与自洽**——这正是 F11 的缺陷："把摘要换成 64 个 `a` 仍通过"。
 * 形状合法 ≠ 内容正确。因此本模块新增**复算守卫**：
 *
 * - `reviewFreezePoint(identity)` —— **总是重新计算**被测文件清单与内容摘要
 *   （算法与口径见 `source-digest.ts`，与历史 FREEZE-3 的 Windows Git 命令逐字节一致），
 *   与候选冻结记录逐字段比较；返回 `FreezeCheck`（含 added / removed / 期望 / 实际）。
 * - `publishFrozenEvidence(identity)` —— **证据发布闸门**。不匹配即抛
 *   `FreezeDigestMismatchError`，**不输出带旧标识的通过证据**（R38.1）。
 * - `developmentEvidence(identity)` —— **开发期输出**。允许偏差，但产物
 *   `frozen: false` / `id: 'DEV-UNFROZEN'`，**不复用 FREEZE-N 的通过身份**，
 *   且与冻结证据写入**不同目录**（R38.4）。
 *
 * 三条硬约束：
 * 1. **不得依赖 `.ts` 内硬编码的最终摘要**（自指，R32.1）——候选冻结点一律作为
 *    **输入**从登记记录读取（本模块只读 `FREEZE_IDENTITY_RECORD_PATH`，不写死摘要值）。
 * 2. **加载期自检刻意不复算**：它被四个验收夹具 import。若在 import 时就因摘要不符而抛错，
 *    所有夹具会在"尚未进入发布路径"时整体崩掉，而不是在**发布证据**那一刻拒绝。
 *    放行判定落在发布路径（`publishFrozenEvidence`）与显式检查（`reviewFreezePoint`）。
 * 3. **守卫不宣布最终冻结 / 最终验收**：冻结证据信封里
 *    `declared_final_by_guard: false` + `independent_review: 'required'`，
 *    最终冻结点登记与独立复核由他人完成。
 *
 * ---------------------------------------------------------------------------
 * ## G04 / G05（合同 v1.3，R45–R46）
 *
 * - **G04（R45）**：冻结身份**必须绑定执行配置**。`compareWithFreezePoint()` 对未登记
 *   `config_digest` 的候选由 `match: null`（不判失败）改为 `match: false`，`ok`、
 *   `publishFrozenEvidence()`、`evidenceIdentityStamp().frozen` 随之全部拒绝；身份戳与正式
 *   信封携带配置登记值 / 复算值 / 比对结论。**不设"为了兼容历史而放宽"的分支**：历史记录
 *   （FREEZE-1…4）原样保留、仍能读入，但其产物自此自动降级为开发身份（R45.3）。
 * - **G05（R46）**：证据**落盘目录由身份决定**。`evidenceOutputLocation()` 是唯一目录来源，
 *   `writeEvidenceArtifacts()` 是唯一写盘入口（JSON / JSONL / 附件同一 location）；
 *   `frozen: true` → `docs/other/evidence/{freeze_id}/`，否则 → `.dev-evidence/{freeze_id}/`，
 *   新运行**不得**写进既有的 `docs/other/evidence/D*` 目录。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIGEST_ALGORITHM_NOTE,
  computeConfigDigest,
  computeSrcOnlyDigest,
  computeTreeDigest,
  SRC_ONLY_SCOPE_DIRS,
  TREE_SCOPE_DIRS,
  type SourceTreeDigest,
} from './source-digest.js';

/** 一个已作废的冻结点记录（用于阻止证据引用历史标识）。 */
export interface SupersededFreezePoint {
  readonly id: string;
  readonly source_tree_sha256: string;
  readonly src_only_sha256?: string;
  readonly note?: string;
}

/** 冻结点标识（单一来源的取值形状）。 */
export interface FreezeIdentity {
  readonly schema: string;
  /** 冻结点名，形如 `FREEZE-3`。 */
  readonly id: string;
  /** 该冻结点的人读证据文档（`docs/other/evidence/FREEZE-N.md`）。 */
  readonly evidence_file: string;
  /** `find src tests -name "*.ts" | sort | xargs sha256sum | sha256sum`。 */
  readonly source_tree_sha256: string;
  /** `find src -name "*.ts" | sort | xargs sha256sum | sha256sum`（与上一值**不同域**，不可互相换算）。 */
  readonly src_only_sha256: string;
  readonly digest_command: string;
  readonly src_digest_command: string;
  readonly note?: string;
  readonly superseded: readonly SupersededFreezePoint[];
  /**
   * 可选：登记时的被测文件清单（相对仓库根的 POSIX 路径，已按口径排序）。
   * 给出后，复算比对能精确区分**新增 / 删除 / 重命名**；不给则退化为"整体摘要不符"。
   */
  readonly source_tree_files?: readonly string[];
  /** 可选：仅 `src` 域的文件清单（同上）。 */
  readonly src_only_files?: readonly string[];
  /**
   * 配置 / 依赖清单的**独立**摘要（R38.2 / R45.1）。这些文件不在 `.ts` 摘要域内，故单独登记。
   *
   * **R45.2：新冻结点必须登记**——未登记时 `compareWithFreezePoint().config.match = false`，
   * `ok`、`publishFrozenEvidence()`、`evidenceIdentityStamp().frozen` 随之全部拒绝。
   * 字段在**类型上**仍可选，只是为了让历史记录（FREEZE-1…4）能原样保留、原样读入
   * （R45.3）；"可选"只影响**能否读入**，不再影响**能否放行**。
   */
  readonly config_digest?: string;
}

/** 一次复算比对的结果（无副作用；可直接序列化进证据）。 */
export interface FreezeCheck {
  /** 候选冻结点的 id（来自登记记录，**不是**硬编码）。 */
  readonly freeze_id: string;
  /** 全部登记项都匹配（含已登记的 config_digest）。 */
  readonly ok: boolean;
  readonly source_tree: FreezeScopeCheck;
  readonly src_only: FreezeScopeCheck;
  /**
   * 配置 / 依赖清单摘要核对（**R45.2**）。
   *
   * `registered: false` = 该登记记录未给出 `config_digest`——此时 `match` **恒为 `false`**：
   * 新冻结点必须登记配置摘要，缺失一律不得 `frozen: true`，**不设"为了兼容历史而放宽"的分支**。
   * （历史 FREEZE-1…4 的记录原样保留，其产物在本批之后自动降级为开发身份，见 R45.3。）
   */
  readonly config: {
    readonly registered: boolean;
    readonly registered_value: string | null;
    readonly actual: string;
    readonly match: boolean;
  };
  /** 人读偏差说明（`ok` 为真时为空数组）。 */
  readonly deviations: readonly string[];
}

/** 单个摘要域的比对结果。 */
export interface FreezeScopeCheck {
  readonly scope: readonly string[];
  readonly expected: string;
  readonly actual: string;
  readonly match: boolean;
  /** 登记记录给出的该域名（当且仅当登记了 `*_files` 时非空）。 */
  readonly declared_files: readonly string[];
  /** 登记清单条目数；`null` = 该登记记录未给出清单（无法精确诊断增删）。 */
  readonly declared_file_count: number | null;
  readonly actual_file_count: number;
  /** 实际有、登记清单没有（含重命名的新名字）。 */
  readonly added: readonly string[];
  /** 登记清单有、实际没有（含重命名的旧名字）。 */
  readonly removed: readonly string[];
}

/** 标识记录文件（相对仓库根；**刻意不是 `.ts`**，见文件头说明）。 */
export const FREEZE_IDENTITY_RECORD_PATH =
  'docs/other/evidence/D11/freeze-identity.json';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FREEZE_ID_PATTERN = /^FREEZE-\d+$/;

/** 冻结点标识自检失败（形状非法、自相矛盾、或引用了已作废的冻结点）。 */
export class FreezeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreezeIdentityError';
  }
}

/** **复算摘要与登记记录不符**（F11 的主失败：形状合法但内容对不上）。 */
export class FreezeDigestMismatchError extends FreezeIdentityError {
  readonly check: FreezeCheck;

  constructor(message: string, check: FreezeCheck) {
    super(message);
    this.name = 'FreezeDigestMismatchError';
    this.check = check;
  }
}

function requireSha(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new FreezeIdentityError(
      `冻结点标识的 ${field} 不是 64 位小写十六进制 sha256：${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 冻结点标识的**自检**（不读文件、不猜值；只对给定记录做形状与自洽判定）。
 *
 * 硬失败项：
 * 1. `id` 形如 `FREEZE-N`；`evidence_file` 与 `id` 同名；
 * 2. 两个摘要都是 64 位小写十六进制，且**彼此不同**（域不同，相同只可能是复制错）；
 * 3. 两条计算命令非空且都含 `sha256sum`；
 * 4. **当前摘要不得出现在 `superseded` 里**——即"更早冻结点记录不能替代当前集成结果"（R24）
 *    的机器判据。
 */
export function assertFreezeIdentity(identity: FreezeIdentity): void {
  if (!FREEZE_ID_PATTERN.test(identity.id)) {
    throw new FreezeIdentityError(`冻结点 id 形状非法：${JSON.stringify(identity.id)}（应为 FREEZE-N）`);
  }
  const expectedFile = `docs/other/evidence/${identity.id}.md`;
  if (identity.evidence_file !== expectedFile) {
    throw new FreezeIdentityError(
      `冻结点标识自相矛盾：id=${identity.id} 但 evidence_file=${identity.evidence_file}（应为 ${expectedFile}）`,
    );
  }
  const full = requireSha(identity.source_tree_sha256, 'source_tree_sha256');
  const srcOnly = requireSha(identity.src_only_sha256, 'src_only_sha256');
  if (full === srcOnly) {
    throw new FreezeIdentityError(
      '全量摘要与仅 src 摘要相同：两者摘要域不同（全量含 tests/**），相同只可能是抄写错误',
    );
  }
  for (const [field, command] of [
    ['digest_command', identity.digest_command],
    ['src_digest_command', identity.src_digest_command],
  ] as const) {
    if (typeof command !== 'string' || command.length === 0 || !command.includes('sha256sum')) {
      throw new FreezeIdentityError(`冻结点标识的 ${field} 未给出可复算的 sha256sum 命令`);
    }
  }
  if (identity.digest_command === identity.src_digest_command) {
    throw new FreezeIdentityError(
      '全量与仅 src 的计算命令相同：两者摘要域不同，相同只可能是抄写错误',
    );
  }

  // 可选的清单 / 配置摘要字段：**仅在登记时校验形状**（不登记者不判失败）。
  for (const [field, list] of [
    ['source_tree_files', identity.source_tree_files],
    ['src_only_files', identity.src_only_files],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      throw new FreezeIdentityError(`冻结点标识的 ${field} 必须是相对路径字符串数组`);
    }
    if (new Set(list).size !== list.length) {
      throw new FreezeIdentityError(`冻结点标识的 ${field} 含重复路径（清单必须是集合）`);
    }
  }
  if (identity.config_digest !== undefined) {
    requireSha(identity.config_digest, 'config_digest');
  }

  const supersededDigests = new Set<string>();
  for (const old of identity.superseded) {
    supersededDigests.add(old.source_tree_sha256);
    if (old.src_only_sha256 !== undefined) supersededDigests.add(old.src_only_sha256);
  }
  for (const [field, value] of [
    ['source_tree_sha256', full],
    ['src_only_sha256', srcOnly],
  ] as const) {
    if (supersededDigests.has(value)) {
      throw new FreezeIdentityError(
        `冻结点标识引用了**已作废**的冻结点：当前 ${field}=${value} 出现在 superseded 列表里。` +
          '按 R24，更早冻结点记录不能替代当前集成结果——请重跑全仓并登记新的冻结点（FREEZE-3）。',
      );
    }
  }
}

let cached: FreezeIdentity | null = null;

/**
 * 读取（并缓存）冻结点标识：读 `FREEZE_IDENTITY_RECORD_PATH` → 解析 → **自检**。
 *
 * @throws {FreezeIdentityError} 记录缺失、不是合法 JSON、或缺必填字段 / 自检不通过时。
 */
export function freezePoint(): FreezeIdentity {
  if (cached !== null) return cached;
  const path = join(REPO_ROOT, ...FREEZE_IDENTITY_RECORD_PATH.split('/'));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new FreezeIdentityError(
      `读不到冻结点标识记录 ${FREEZE_IDENTITY_RECORD_PATH}：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FreezeIdentityError(
      `冻结点标识记录不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const identity = parsed as FreezeIdentity;
  if (
    typeof identity.id !== 'string' ||
    typeof identity.evidence_file !== 'string' ||
    typeof identity.source_tree_sha256 !== 'string' ||
    typeof identity.src_only_sha256 !== 'string' ||
    typeof identity.digest_command !== 'string' ||
    typeof identity.src_digest_command !== 'string' ||
    !Array.isArray(identity.superseded)
  ) {
    throw new FreezeIdentityError(
      `冻结点标识记录缺必填字段（需要 id / evidence_file / source_tree_sha256 / ` +
        `src_only_sha256 / digest_command / src_digest_command / superseded）`,
    );
  }
  assertFreezeIdentity(identity);
  cached = Object.freeze(identity);
  return cached;
}

/** 证据 JSON 里引用的冻结点标识（`file` = 人读证据文档，`source_tree_sha256` = 全量摘要）。 */
export interface FreezePointEvidence {
  readonly id: string;
  readonly file: string;
  readonly source_tree_sha256: string;
  readonly src_only_sha256: string;
}

/** 供证据 JSON 使用的标识切片（四个夹具一律经此取值）。 */
export function freezePointEvidence(): FreezePointEvidence {
  return evidenceFor(freezePoint());
}

/**
 * 把**任意**候选冻结记录投影成证据切片。
 *
 * 守卫的发布 / 开发期信封一律走这里，**不**偷偷改用模块级已登记记录——
 * 否则对合成候选（临时目录）发布时会出现"信封标识 ≠ 信封内复算值"的自相矛盾。
 */
function evidenceFor(identity: FreezeIdentity): FreezePointEvidence {
  return Object.freeze({
    id: identity.id,
    file: identity.evidence_file,
    source_tree_sha256: identity.source_tree_sha256,
    src_only_sha256: identity.src_only_sha256,
  });
}

/** 全量（src + tests）源码树摘要。 */
export function freezeSourceTreeDigest(): string {
  return freezePoint().source_tree_sha256;
}

/** 仅 `src/` 源码树摘要（与全量**不同域**，不可比较）。 */
export function freezeSrcOnlyDigest(): string {
  return freezePoint().src_only_sha256;
}

/** 冻结点名（形如 `FREEZE-3`）。 */
export function freezeId(): string {
  return freezePoint().id;
}

/** 该冻结点的人读证据文档路径。 */
export function freezeEvidenceFile(): string {
  return freezePoint().evidence_file;
}

// 加载期自检：任何引用旧标识（或标识记录损坏）的夹具会在 import 时就失败，而不是写出
// 一份自称过期的证据。这正是 D10 找到的那类事故（证据自称 FREEZE-1、实为 FREEZE-2 源码）。
//
// **刻意只做形状 / 自洽自检，不复算摘要**：本模块被四个验收夹具 import，若在 import 期
// 因"当前工作区摘要 ≠ 登记摘要"而抛错，夹具会在尚未走到发布路径时整体崩掉。内容比对
// 属于**发布闸门**（`publishFrozenEvidence`）与显式检查（`reviewFreezePoint`）的职责。
freezePoint();

// ===========================================================================
// F11 复算守卫（R38.1–R38.4）
// ===========================================================================

/** 一次完整复算的三条摘要（源码全量 / 仅 src / 配置清单）。 */
export interface RecomputedDigests {
  readonly source_tree: SourceTreeDigest;
  readonly src_only: SourceTreeDigest;
  readonly config: ReturnType<typeof computeConfigDigest>;
}

/**
 * **重新计算**被测摘要（不读登记记录、不猜值）。默认在被测仓库上进行。
 *
 * 这是 R38.1 的"证据发布前重新计算"入口；所有放行判定都从这里取值。
 */
export function recomputeDigests(root: string = REPO_ROOT): RecomputedDigests {
  return Object.freeze({
    source_tree: computeTreeDigest(root),
    src_only: computeSrcOnlyDigest(root),
    config: computeConfigDigest(root),
  });
}

/** 登记清单（或未登记时）与实际清单的差集比对。 */
function compareScope(
  scope: readonly string[],
  expected: string,
  actual: SourceTreeDigest,
  declaredFiles: readonly string[] | undefined,
): FreezeScopeCheck {
  const declared = declaredFiles ?? [];
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual.files.map((entry) => entry.path));
  const added = declaredFiles === undefined
    ? []
    : actual.files.map((entry) => entry.path).filter((path) => !declaredSet.has(path));
  const removed = declared.filter((path) => !actualSet.has(path));
  return Object.freeze({
    scope: Object.freeze([...scope]),
    expected,
    actual: actual.sha256,
    match: expected === actual.sha256,
    declared_files: Object.freeze([...declared]),
    declared_file_count: declaredFiles === undefined ? null : declared.length,
    actual_file_count: actual.files.length,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
  });
}

/**
 * **纯比对**：把复算结果与候选冻结记录逐字段比较。不读文件、不产生副作用，便于
 * 用**注入清单**构造"域内新增 / 删除 / 重命名"等场景（无需真的改动仓库源码）。
 */
export function compareWithFreezePoint(
  identity: FreezeIdentity,
  recomputed: RecomputedDigests,
): FreezeCheck {
  const sourceTree = compareScope(
    TREE_SCOPE_DIRS,
    identity.source_tree_sha256,
    recomputed.source_tree,
    identity.source_tree_files,
  );
  const srcOnly = compareScope(
    SRC_ONLY_SCOPE_DIRS,
    identity.src_only_sha256,
    recomputed.src_only,
    identity.src_only_files,
  );
  const configRegistered = identity.config_digest !== undefined;
  // R45.2：未登记 ⇒ `false`（**不是** `null`）。缺登记不再"不判失败"。
  const configMatch = configRegistered
    ? identity.config_digest === recomputed.config.sha256
    : false;

  const deviations: string[] = [];
  for (const [label, scopeCheck, field] of [
    ['全量（src + tests）', sourceTree, 'source_tree_sha256'],
    ['仅 src', srcOnly, 'src_only_sha256'],
  ] as const) {
    if (!scopeCheck.match) {
      deviations.push(
        `${label}摘要不符：登记 ${scopeCheck.expected}，实际复算 ${scopeCheck.actual}`,
      );
    }
    if (scopeCheck.declared_file_count !== null && scopeCheck.added.length > 0) {
      deviations.push(`${label}域内**新增**文件：${scopeCheck.added.join(', ')}`);
    }
    if (scopeCheck.removed.length > 0) {
      deviations.push(`${label}域内**删除/重命名离开**文件：${scopeCheck.removed.join(', ')}`);
    }
    if (scopeCheck.declared_file_count !== null && scopeCheck.declared_file_count !== scopeCheck.actual_file_count) {
      deviations.push(
        `${label}文件数不符：登记 ${scopeCheck.declared_file_count}，实际 ${scopeCheck.actual_file_count}（${field}）`,
      );
    }
  }
  if (!configRegistered) {
    deviations.push(
      '未登记 config_digest（R45.1 / R45.2）：新冻结点必须登记 package.json / pnpm-lock.yaml / ' +
        'tsconfig.json / vitest.config.ts 的配置摘要；缺失一律不得 frozen: true。',
    );
  } else if (!configMatch) {
    deviations.push(
      `配置 / 依赖清单摘要不符（R45.1）：登记 ${String(identity.config_digest)}，` +
        `实际复算 ${recomputed.config.sha256}`,
    );
  }

  const ok =
    sourceTree.match && srcOnly.match && configMatch && deviations.length === 0;
  return Object.freeze({
    freeze_id: identity.id,
    ok,
    source_tree: sourceTree,
    src_only: srcOnly,
    config: Object.freeze({
      registered: configRegistered,
      registered_value: registeredOrNull(identity.config_digest),
      actual: recomputed.config.sha256,
      match: configMatch,
    }),
    deviations: Object.freeze(deviations),
  });
}

function registeredOrNull(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

/**
 * **复算并比对**当前工作区与给定候选冻结点（R38.1）。
 *
 * @param options.root 被测仓库根；默认本仓库根。测试用临时目录时显式传入。
 */
export function reviewFreezePoint(
  identity: FreezeIdentity,
  options: { readonly root?: string } = {},
): FreezeCheck {
  return compareWithFreezePoint(
    identity,
    recomputeDigests(options.root ?? REPO_ROOT),
  );
}

/** 复算并比对**已登记的**当前冻结点（读取 `FREEZE_IDENTITY_RECORD_PATH`）。 */
export function reviewRegisteredFreezePoint(
  options: { readonly root?: string } = {},
): FreezeCheck {
  return reviewFreezePoint(freezePoint(), options);
}

// --- 证据信封：正式发布 vs 开发期检查（R38.4） ------------------------------

/** 正式冻结证据的输出目录模板（新冻结点证据；与历史 D 目录分开）。 */
export const FROZEN_EVIDENCE_DIR_TEMPLATE = 'docs/other/evidence/{freeze_id}';

/** 开发期检查输出的根目录（**不是**证据目录，产物恒为"未冻结"）。 */
export const DEVELOPMENT_EVIDENCE_DIR_ROOT = '.dev-evidence';

/** 正式冻结证据的输出目录（相对仓库根）。 */
export function frozenEvidenceDir(identity: FreezeIdentity): string {
  return FROZEN_EVIDENCE_DIR_TEMPLATE.replace('{freeze_id}', identity.id);
}

/** 开发期检查的输出目录（相对仓库根）；**与冻结证据分目录**。 */
export function developmentEvidenceDir(candidateFreezeId: string): string {
  return `${DEVELOPMENT_EVIDENCE_DIR_ROOT}/${candidateFreezeId}`;
}

/** 信封里的复算字段（期望值来自复算，不是抄登记值）。 */
export interface RecomputedEvidenceFields {
  readonly source_tree_sha256: string;
  readonly src_only_sha256: string;
  readonly source_tree_file_count: number;
  readonly src_only_file_count: number;
  readonly config_sha256: string;
  readonly digest_algorithm: string;
}

function recomputedFields(recomputed: RecomputedDigests): RecomputedEvidenceFields {
  return Object.freeze({
    source_tree_sha256: recomputed.source_tree.sha256,
    src_only_sha256: recomputed.src_only.sha256,
    source_tree_file_count: recomputed.source_tree.files.length,
    src_only_file_count: recomputed.src_only.files.length,
    config_sha256: recomputed.config.sha256,
    digest_algorithm: DIGEST_ALGORITHM_NOTE,
  });
}

/** **正式冻结证据**信封（仅在复算匹配时产生）。 */
export interface FrozenEvidenceEnvelope {
  readonly schema: 'freeze-evidence.v1';
  readonly frozen: true;
  readonly freeze_point: FreezePointEvidence;
  /** 登记记录里的配置 / 依赖清单摘要（R45.4；`frozen: true` ⇒ 必然已登记）。 */
  readonly config_digest: string;
  readonly recomputed: RecomputedEvidenceFields;
  readonly digest_command: string;
  readonly src_digest_command: string;
  readonly output_dir: string;
  readonly verification: {
    readonly recomputed_before_publish: true;
    readonly matches_registered: true;
  };
  /** 守卫**不**宣布最终冻结 / 最终验收：仍需独立复核在同一冻结点重跑。 */
  readonly independent_review: 'required';
  readonly declared_final_by_guard: false;
}

/**
 * **证据身份戳**（R38.4）：给验收产物用的、**经过复算**的身份切片。
 *
 * 为什么需要它：夹具落盘的 JSON 若直接抄登记记录里的 `FREEZE-3` 摘要，
 * 就是"复用旧通过身份"——源码改动后照旧写出带旧标识的通过证据，正是 F11 要消灭的失效模式。
 *
 * 语义：
 * - 复算与登记记录**匹配** ⇒ `frozen: true`，`id` = 登记冻结点（此时确实就是那个冻结点）；
 * - **不匹配** ⇒ `frozen: false`，`id = 'DEV-UNFROZEN'`，摘要字段换成**本次复算值**，
 *   并带上 `deviations`。下游据此一眼看出"这是开发期输出，不是冻结证据"。
 *
 * 守卫**不**宣布最终冻结或最终验收（`declared_final_by_guard: false`）。
 *
 * R45.4：本戳同时携带**配置 / 依赖清单**的登记值（`config_sha256`）、本次复算值
 * （`recomputed_config_sha256`）与比对结论（`config_match`）——配置未登记时 `frozen` 必为 `false`。
 */
export interface EvidenceIdentityStamp {
  readonly frozen: boolean;
  readonly id: string;
  readonly file: string;
  readonly source_tree_sha256: string;
  readonly src_only_sha256: string;
  readonly recomputed_source_tree_sha256: string;
  readonly recomputed_src_only_sha256: string;
  /**
   * **登记**记录里的配置 / 依赖清单摘要（R45.4）；`null` = 该冻结点未登记 `config_digest`，
   * 此时 `config_match` 恒为 `false`、`frozen` 恒为 `false`（R45.2）。
   */
  readonly config_sha256: string | null;
  /** 本次**复算**的配置 / 依赖清单摘要（R45.4）。 */
  readonly recomputed_config_sha256: string;
  /** 登记值与复算值是否一致（R45.4）；未登记时恒为 `false`。 */
  readonly config_match: boolean;
  readonly source_tree_file_count: number;
  readonly src_only_file_count: number;
  readonly deviations: readonly string[];
  readonly notice: string;
  readonly independent_review: 'required';
  readonly declared_final_by_guard: false;
}

export function evidenceIdentityStamp(options: { readonly root?: string } = {}): EvidenceIdentityStamp {
  const registered = freezePoint();
  const recomputed = recomputeDigests(options.root);
  const check = compareWithFreezePoint(registered, recomputed);
  return Object.freeze({
    frozen: check.ok,
    id: check.ok ? registered.id : 'DEV-UNFROZEN',
    file: registered.evidence_file,
    source_tree_sha256: check.ok ? registered.source_tree_sha256 : recomputed.source_tree.sha256,
    src_only_sha256: check.ok ? registered.src_only_sha256 : recomputed.src_only.sha256,
    recomputed_source_tree_sha256: recomputed.source_tree.sha256,
    recomputed_src_only_sha256: recomputed.src_only.sha256,
    // R45.4：配置复算与比对结果**写入实际产物身份戳**。
    config_sha256: registered.config_digest ?? null,
    recomputed_config_sha256: recomputed.config.sha256,
    config_match: check.config.match,
    source_tree_file_count: recomputed.source_tree.files.length,
    src_only_file_count: recomputed.src_only.files.length,
    deviations: check.deviations,
    notice: check.ok
      ? `复算与登记冻结点 ${registered.id} 一致（R38.1；配置摘要 ${recomputed.config.sha256}）`
      : '开发期输出（未冻结）：本次复算与登记冻结点不符，**不复用其通过身份**（R38.4）。' +
        '正式验收证据必须先登记新的冻结点。',
    independent_review: 'required',
    declared_final_by_guard: false,
  });
}

/** **开发期检查**产物信封（明确未冻结，不复用 FREEZE-N 的通过身份）。 */
export interface DevelopmentEvidenceEnvelope {
  readonly schema: 'freeze-evidence.v1';
  readonly frozen: false;
  /** 刻意**不是** `FREEZE-N`，避免被下游当成通过身份。 */
  readonly id: 'DEV-UNFROZEN';
  readonly candidate_freeze_point: FreezePointEvidence;
  readonly recomputed: RecomputedEvidenceFields;
  readonly digest_algorithm: string;
  readonly deviations: readonly string[];
  readonly output_dir: string;
  readonly notice: string;
  readonly independent_review: 'required';
  readonly declared_final_by_guard: false;
}

/** 拼一份可读的失配说明（含 added / removed / 期望 / 实际）。 */
function describeMismatch(check: FreezeCheck): string {
  return (
    `冻结守卫拒绝发布带 ${check.freeze_id} 标识的证据：复算摘要与登记记录不符（F11 / R38.1）。` +
    check.deviations.map((line) => `\n  - ${line}`).join('')
  );
}

/**
 * **证据发布闸门**（R38.1）——发布前重新计算被测文件清单与内容摘要，与候选冻结记录比较。
 *
 * 不匹配即抛 `FreezeDigestMismatchError`，**不产出任何带旧标识的通过证据**。
 * 摘要域内的**任何**一个字节变化、或域内文件的增 / 删 / 改名，都会改变整体摘要而触发拒绝。
 *
 * 守卫不宣布最终冻结：返回的信封恒带 `independent_review: 'required'` 与
 * `declared_final_by_guard: false`。
 */
export function publishFrozenEvidence(
  identity: FreezeIdentity,
  options: { readonly root?: string } = {},
): FrozenEvidenceEnvelope {
  // 候选**自检**（W2 登记的 N-新2）：发布闸门先跑形状 / 自洽自检，错误 id、空摘要命令之类的
  // 伪造候选一律在此抛 `FreezeIdentityError`，**不得**产出 `frozen: true` 的信封。
  // 注意：`assertFreezeIdentity()` 刻意只做形状与自洽、**不**复算（见文件头第 2 条），
  // 因此在 import 期不会因摘要不符而崩掉夹具；内容比对仍由下面的复算守卫负责。
  assertFreezeIdentity(identity);
  const recomputed = recomputeDigests(options.root ?? REPO_ROOT);
  const check = compareWithFreezePoint(identity, recomputed);
  if (!check.ok) throw new FreezeDigestMismatchError(describeMismatch(check), check);
  const configDigest = identity.config_digest;
  if (configDigest === undefined) {
    // `check.ok` 已经排除未登记（R45.2）；这里是不可达的内部矛盾防护，而不是放宽分支。
    throw new FreezeIdentityError(
      '内部矛盾：复算比对判定 ok 但登记记录没有 config_digest（R45.2 不得放行）',
    );
  }
  return Object.freeze({
    schema: 'freeze-evidence.v1',
    frozen: true,
    freeze_point: evidenceFor(identity),
    config_digest: configDigest,
    recomputed: recomputedFields(recomputed),
    digest_command: identity.digest_command,
    src_digest_command: identity.src_digest_command,
    output_dir: frozenEvidenceDir(identity),
    verification: Object.freeze({
      recomputed_before_publish: true,
      matches_registered: true,
    }),
    independent_review: 'required',
    declared_final_by_guard: false,
  });
}

/**
 * **开发期检查输出**（R38.4）——允许摘要不符，但产物恒为"未冻结"：
 * `frozen: false`、`id: 'DEV-UNFROZEN'`、候选标识嵌在 `candidate_freeze_point` 下，
 * 且写入与正式证据**不同**的目录。下游不得把它当作 FREEZE-N 的通过证据。
 */
export function developmentEvidence(
  identity: FreezeIdentity,
  options: { readonly root?: string; readonly note?: string } = {},
): DevelopmentEvidenceEnvelope {
  const recomputed = recomputeDigests(options.root ?? REPO_ROOT);
  const check = compareWithFreezePoint(identity, recomputed);
  return Object.freeze({
    schema: 'freeze-evidence.v1',
    frozen: false,
    id: 'DEV-UNFROZEN',
    candidate_freeze_point: evidenceFor(identity),
    recomputed: recomputedFields(recomputed),
    digest_algorithm: DIGEST_ALGORITHM_NOTE,
    deviations: check.deviations,
    output_dir: developmentEvidenceDir(identity.id),
    notice:
      '开发期检查产物，**未冻结**：不复用任何冻结点的通过身份，不得作为验收证据。' +
      'final freeze / acceptance 由独立复核在同一冻结点重跑后另行登记。' +
      (options.note === undefined ? '' : ` note=${options.note}`),
    independent_review: 'required',
    declared_final_by_guard: false,
  });
}

/** 判别器：是否是**正式冻结证据**（开发期产物恒为 `false`）。 */
export function isFrozenEvidence(
  record: FrozenEvidenceEnvelope | DevelopmentEvidenceEnvelope,
): boolean {
  return record.frozen === true;
}

/** 开发期产物自检：必须 `frozen: false`，且**不得**复用 `FREEZE-N` 身份。 */
export function assertDevelopmentEvidence(envelope: DevelopmentEvidenceEnvelope): void {
  if (envelope.frozen !== false) {
    throw new FreezeIdentityError('开发期产物不得声明 frozen: true（R38.4）');
  }
  if (FREEZE_ID_PATTERN.test(envelope.id)) {
    throw new FreezeIdentityError(
      `开发期产物复用了冻结点通过身份 ${envelope.id}：必须标为未冻结（R38.4）`,
    );
  }
  if (envelope.declared_final_by_guard !== false || envelope.independent_review !== 'required') {
    throw new FreezeIdentityError('开发期产物不得宣布最终冻结 / 最终验收（守卫只做发布前复算）');
  }
}

/**
 * 正式证据自检：`frozen: true`，且信封里的标识与复算值**一致**。
 *
 * R45.4 追加**配置自洽**校验：信封里的登记配置摘要必须等于同一信封内的**复算**配置摘要——
 * 正式产物只接受"登记值 == 复算值"的同版产物，抄写 / 自指 / 拼装错误一律拒绝。
 */
export function assertFrozenEvidence(envelope: FrozenEvidenceEnvelope): void {
  if (envelope.frozen !== true) {
    throw new FreezeIdentityError('正式证据必须声明 frozen: true');
  }
  assertFreezeIdentity(freezePoint());
  if (envelope.freeze_point.source_tree_sha256 !== envelope.recomputed.source_tree_sha256) {
    throw new FreezeIdentityError(
      '正式证据自相矛盾：freeze_point 标识与同一信封内的复算值不一致（自指 / 抄写错误）',
    );
  }
  requireSha(envelope.config_digest, 'config_digest');
  if (envelope.config_digest !== envelope.recomputed.config_sha256) {
    throw new FreezeIdentityError(
      '正式证据自相矛盾：信封登记配置摘要与同一信封内的**复算**配置摘要不一致（R45.4）——' +
        `登记 ${envelope.config_digest}，复算 ${envelope.recomputed.config_sha256}`,
    );
  }
  if (envelope.declared_final_by_guard !== false || envelope.independent_review !== 'required') {
    throw new FreezeIdentityError('守卫不得宣布最终冻结：须标 independent_review=required');
  }
}

// ===========================================================================
// G05 证据发布器：身份与落盘目录**同一处决定**（合同 R46.1–R46.5）
// ---------------------------------------------------------------------------
// 缺陷（G05）：身份戳虽已复算，各写入器却仍写**固定目录** —— 源码 / 配置失配后的
// 开发期运行会把 `docs/other/evidence/D**/` 里的已冻结验收产物**覆盖**成 DEV-UNFROZEN。
// 修法：把"写到哪儿"从各写入器搬到这里，产物目录由**身份**决定（R46.1）：
//
//   frozen: true  → docs/other/evidence/{registered_freeze_id}/
//   frozen: false → .dev-evidence/{registered_freeze_id}/
//
// 三条纪律：
//   * R46.2 —— **同一目录选择覆盖全部产物**：JSON / JSONL / 附件一律走同一 location，
//     `writeEvidenceArtifacts()` 一次调用内只决定一个目录；
//   * R46.3 —— 新运行**不得**写进 `docs/other/evidence/D**/`（那里面是历史产物与登记文件）；
//   * R46.4 —— 落盘前先过守卫；守卫拒绝时**不写任何文件**，且先写临时文件再原子改名，
//     已存在的同名文件不会被部分覆盖。
// ===========================================================================

/** 证据产物的落盘位置（R46.1：由**身份**决定，不由各写入器自选）。 */
export interface EvidenceOutputLocation {
  /** 本次执行的身份是否为正式冻结（与 `EvidenceIdentityStamp.frozen` 同源）。 */
  readonly frozen: boolean;
  /** 本次产物身份：`FREEZE-N`（正式）或 `DEV-UNFROZEN`（开发期）。 */
  readonly id: string;
  /** **始终**是登记冻结点 id——目录模板用它（R46.1 表格）。 */
  readonly registered_freeze_id: string;
  /** 相对仓库根：`docs/other/evidence/{registered_freeze_id}` 或 `.dev-evidence/{registered_freeze_id}`。 */
  readonly dir: string;
  /** 同一个目录的绝对路径（`mkdir -p` 与写盘都用它）。 */
  readonly absolute_dir: string;
  readonly notice: string;
}

/** 由一个**已经算好的**身份戳决定落盘位置（纯函数：不读盘、不写盘）。 */
function locationFromStamp(stamp: EvidenceIdentityStamp, root: string): EvidenceOutputLocation {
  const registeredId = freezePoint().id;
  const dir = stamp.frozen
    ? FROZEN_EVIDENCE_DIR_TEMPLATE.replace('{freeze_id}', registeredId)
    : developmentEvidenceDir(registeredId);
  return Object.freeze({
    frozen: stamp.frozen,
    id: stamp.id,
    registered_freeze_id: registeredId,
    dir,
    absolute_dir: join(root, ...dir.split('/')),
    notice: stamp.frozen
      ? `正式冻结证据：写入 docs/other/evidence/${registeredId}/（R46.1）`
      : `开发期产物（未冻结）：写入 .dev-evidence/${registeredId}/，**不触碰** docs/other/evidence/**` +
        '（R46.1 / R46.3 / R46.4）',
  });
}

/**
 * 由一个**已经算好的**身份戳取落盘位置（R46.1；纯函数，**不重新复算** `src/**` + `tests/**`）。
 *
 * 与 {@link evidenceOutputLocation} 同源——后者就等于
 * `evidenceOutputLocationFromStamp(evidenceIdentityStamp(options), options)`。
 * 存在的意义：同一份快照（一次运行内工作树不变）被多处用到时，调用方可以自己只算一次
 * 身份戳，再据此取位置，省掉一次全量复算而**不改变结果**（同输入 ⇒ 同戳 ⇒ 同目录）。
 *
 * @param stamp 已经算好的身份戳（由调用方保证其摘要域未变）。
 * @param options.root 落盘根；默认本仓库根。
 */
export function evidenceOutputLocationFromStamp(
  stamp: EvidenceIdentityStamp,
  options: { readonly root?: string } = {},
): EvidenceOutputLocation {
  return locationFromStamp(stamp, options.root ?? REPO_ROOT);
}

/**
 * 本次证据的落盘位置（R46.1）——**全部写入器的唯一目录来源**。
 *
 * @param options.root 被测仓库根（复算与落盘同根）；默认本仓库根。
 */
export function evidenceOutputLocation(
  options: { readonly root?: string } = {},
): EvidenceOutputLocation {
  return evidenceOutputLocationFromStamp(evidenceIdentityStamp(options), options);
}

/** 一份待落盘的证据产物（内容与文件名都由调用方给定；目录由发布器决定）。 */
export interface EvidenceArtifact {
  readonly file_name: string;
  readonly content: string;
}

/** 一份已落盘产物的回执。 */
export interface WrittenEvidenceArtifact {
  readonly file_name: string;
  readonly absolute_path: string;
  readonly byte_length: number;
}

/** 一次落盘的结果（含身份与位置，便于证据自证与测试读回）。 */
export interface EvidenceWriteOutcome {
  readonly location: EvidenceOutputLocation;
  readonly identity: EvidenceIdentityStamp;
  readonly written: readonly WrittenEvidenceArtifact[];
}

let tempSerial = 0;

/**
 * **唯一的证据写盘入口**（R46.1 / R46.2 / R46.4）。
 *
 * 调用方以 `build(identity)` 给出产物：目录与身份在**同一次计算**里确定，因此落盘位置与
 * 产物内的身份戳**不可能不一致**（这是 R46.1「同一处决定」的可执行形式）。
 *
 * 顺序（R46.4）：先算身份 → 过守卫 → 建目录 → 逐份原子写。
 * 守卫拒绝（正式身份复算不匹配）时抛错且**不写任何文件**；开发期身份则只写 `.dev-evidence/`，
 * `docs/other/evidence/**` 一个字节也不碰。
 *
 * `options.stamp`：调用方**已经算好**的身份戳。给了就**不再复算** `src/**` + `tests/**`
 * （结果与现算完全一致——同一摘要域同一时刻 ⇒ 同一戳）；不给则维持原有"现算"语义。
 * 无论哪条路径，正式身份的**发布闸门**（`publishFrozenEvidence`）仍会**独立重算**一次，
 * 守卫的"真的重算"不受影响。
 */
export function writeEvidenceArtifacts(
  build: (identity: EvidenceIdentityStamp) => readonly EvidenceArtifact[],
  options: { readonly root?: string; readonly stamp?: EvidenceIdentityStamp } = {},
): EvidenceWriteOutcome {
  const root = options.root ?? REPO_ROOT;
  const identity = options.stamp ?? evidenceIdentityStamp(options);
  const location = locationFromStamp(identity, root);

  // R46.4：落盘前先过守卫。正式身份复跑发布闸门——不匹配即抛，**在 mkdir 之前**。
  if (identity.frozen) {
    publishFrozenEvidence(freezePoint(), { root });
  }

  const artifacts = build(identity);
  for (const artifact of artifacts) {
    if (!isPlainFileName(artifact.file_name)) {
      throw new FreezeIdentityError(
        `证据文件名必须是单一文件名（不含路径分隔符 / ".."）：${JSON.stringify(artifact.file_name)}（R46.2）`,
      );
    }
  }

  mkdirSync(location.absolute_dir, { recursive: true });
  const written = artifacts.map((artifact) => {
    const absolute = join(location.absolute_dir, artifact.file_name);
    // R46.4：先写临时文件、再原子改名——已存在的同名文件不会被部分覆盖。
    const temp = `${absolute}.tmp-${process.pid}-${(tempSerial += 1)}`;
    writeFileSync(temp, artifact.content, 'utf8');
    renameSync(temp, absolute);
    return Object.freeze({
      file_name: artifact.file_name,
      absolute_path: absolute,
      byte_length: Buffer.byteLength(artifact.content, 'utf8'),
    });
  });

  return Object.freeze({
    location,
    identity,
    written: Object.freeze(written),
  });
}

/** 单一文件名判据（拒绝路径分隔符与 `..`，使产物**必然**落在同一目录内，R46.2）。 */
function isPlainFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    fileName !== '.' &&
    fileName !== '..' &&
    !fileName.includes('/') &&
    !fileName.includes('\\')
  );
}
