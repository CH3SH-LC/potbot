/**
 * 产物计划器（design-02 P1/P2/P3；**纯函数，零 IO**）。
 *
 * 职责只有三件：
 * 1. **派生产物 id**：由 `task_id + task_revision + 模板种类 + 该种类的产物版本` 派生，
 *    **不使用任何计数器**——重放同一计划必须得到同一 id；
 * 2. **版本化路径计划**：最终路径与临时路径（P2：旧版本产物不得覆盖最新文件）；
 * 3. **期望内容摘要的占位**：计划里携带"期望的字节摘要"，真实字节由 W-D 的构建器产出后核对。
 *
 * ## 确定性纪律（Q8-c）
 *
 * - 本模块**没有时间参数**——结构上不可能掺入墙钟（不是"记得不要用 Date"，而是"没有地方可放"）；
 * - 路径由 id / 版本 / 模板种类拼成，**不含** `Date`、`process.pid`、随机数、主机名、语言环境；
 * - 路径分隔符固定 `/`（不随平台 / locale 变化），落盘端口自行按需规范化。
 *
 * ## `{n}` 的边界
 *
 * 临时路径里的 `{n}` 是**尝试序号**，只出现在 `.staging/` 下；它**不得**进入最终路径，
 * 也**不得**参与身份派生（id 只由上面四个语义量决定）——否则"重放得到同一 id"就不成立。
 */

import {
  asArtifactRef,
  type ArtifactRef,
  type Revision,
  type TaskId,
  TEMPLATE_KIND_EXTENSIONS,
  TEMPLATE_KIND_MIME_TYPES,
  TEMPLATE_KINDS,
  type TemplateKind,
} from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
// 复用既有 sha256 助手（**不造第三套**）：`canonicalDigest` 只做"对已规范化文本取摘要"，
// 规范化（本模块的 JSON 数组编码）属本领域的语义，与该模块声明的分工一致。
import { canonicalDigest } from '../dependency/digest.js';

/** 派生 id 的固定前缀（一眼可辨"这是产物 id"，且是合法路径段）。 */
export const ARTIFACT_ID_PREFIX = 'art-';

/** 截取摘要前多少位十六进制字符作为 id 主体（128 bit，足够避免碰撞，且让路径可读）。 */
export const ARTIFACT_ID_DIGEST_LENGTH = 32;

/** 派生 id 所需的语义四元组（顺序即编码顺序，**不得**重排）。 */
export interface ArtifactIdentityInput {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly template_kind: TemplateKind;
  /** 同一任务、同一模板种类下的第几版（从 1 起）。 */
  readonly artifact_version: number;
}

/**
 * 派生产物 id（纯函数、无计数器、无随机数）。
 *
 * 编码为 `art-` + `sha256(JSON.stringify([task_id, task_revision, kind, version]))` 的前 32 位。
 * 用 JSON 数组（而不是拼分隔符）编码：数组无歧义，且 `task_id` 里出现分隔符也不会改变语义。
 */
export function deriveArtifactId(input: ArtifactIdentityInput): ArtifactRef {
  const kind = requireTemplateKind(input.template_kind);
  const version = requirePositiveInteger(input.artifact_version, 'artifact_version');
  const taskRevision = requireRevision(input.task_revision);
  const encoded = JSON.stringify([String(input.task_id), taskRevision, kind, version]);
  const digest = canonicalDigest(encoded);
  return asArtifactRef(
    `${ARTIFACT_ID_PREFIX}${digest.slice(0, ARTIFACT_ID_DIGEST_LENGTH)}`,
  );
}

export interface ArtifactPlanInput extends ArtifactIdentityInput {
  /** 注入根（产物写入的基准目录）；末尾斜杠会被规范化掉。 */
  readonly root_dir: string;
  /** 期望的字节摘要（真实字节由构建器给出后核对；这里是**计划值**）。 */
  readonly expected_content_digest: string;
  /** 临时路径的尝试序号 `{n}`（正整数，默认 1）；**不进入最终路径与身份**。 */
  readonly staging_attempt?: number;
}

export interface ArtifactPlan {
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly template_kind: TemplateKind;
  readonly artifact_version: number;
  readonly file_extension: string;
  readonly mime_type: string;
  /** 最终落点：`{root}/{task_id}/r{revision}/{kind}/{artifact_id}.{ext}`。 */
  readonly final_path: string;
  /** 临时落点：同目录下 `.staging/{artifact_id}.tmp-{n}`。 */
  readonly staging_path: string;
  /** 期望内容摘要（计划值，非真实字节摘要）。 */
  readonly expected_content_digest: string;
}

function requireTemplateKind(value: unknown): TemplateKind {
  if (typeof value !== 'string' || !(TEMPLATE_KINDS as readonly string[]).includes(value)) {
    throw new ValidationError(
      `template_kind 必须是 ${TEMPLATE_KINDS.join(' | ')} 之一，收到 ${String(value)}`,
    );
  }
  return value as TemplateKind;
}

function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`task_revision 必须是 ≥ 0 的整数，收到 ${String(value)}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} 必须是 ≥ 1 的整数，收到 ${String(value)}`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串`);
  }
  return value;
}

/** 控制字符 / NUL 出现在路径里会让日志与文本工具链不可读，直接拒绝。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * 校验一个**将被拼进路径**的段：不得含路径分隔符、控制字符，也不得是 `.` / `..`。
 * （`task_id` 会原样进入路径，而 `createIdSource({seed})` 能产出 `seed/task-1` 形态的 id。）
 */
function requirePathSegment(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  if (text === '.' || text === '..') {
    throw new ValidationError(`${field} 不得是 ${JSON.stringify(text)}（路径段歧义）`);
  }
  if (/[/\\]/.test(text) || CONTROL_CHARACTERS.test(text)) {
    throw new ValidationError(
      `${field} 含路径分隔符或控制字符（${JSON.stringify(text)}）：不得进入产物路径`,
    );
  }
  return text;
}

function normalizeRootDir(rootDir: unknown): string {
  const text = requireNonEmptyString(rootDir, 'root_dir');
  if (CONTROL_CHARACTERS.test(text)) {
    throw new ValidationError('root_dir 含控制字符：不得进入产物路径');
  }
  // 只去掉**末尾**的 `/`（保留 POSIX 根 `/` 与 Windows 盘符根 `C:/` 的语义）。
  const trimmed = text.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/**
 * 生成产物计划（纯函数）。
 *
 * **重放同一输入 ⇒ 同一 id、同一路径、同一期望摘要**（无计数器、无随机数、无时间）。
 * 改 `task_revision` 或 `artifact_version` ⇒ 路径与 id **同时**变化（P2 的版本化写入）。
 *
 * @throws {ValidationError} 模板种类 / 版本号非法、`root_dir` 或 `task_id` 不适合进入路径。
 */
export function planArtifact(input: ArtifactPlanInput): ArtifactPlan {
  const taskId = requirePathSegment(input.task_id, 'task_id');
  const templateKind = requireTemplateKind(input.template_kind);
  const taskRevision = requireRevision(input.task_revision);
  const artifactVersion = requirePositiveInteger(input.artifact_version, 'artifact_version');
  const stagingAttempt =
    input.staging_attempt === undefined
      ? 1
      : requirePositiveInteger(input.staging_attempt, 'staging_attempt');
  const expectedDigest = requireNonEmptyString(
    input.expected_content_digest,
    'expected_content_digest',
  );
  const root = normalizeRootDir(input.root_dir);

  const artifactId = deriveArtifactId({
    task_id: input.task_id,
    task_revision: input.task_revision,
    template_kind: templateKind,
    artifact_version: artifactVersion,
  });
  const extension = TEMPLATE_KIND_EXTENSIONS[templateKind];
  const directory = `${root}/${taskId}/r${taskRevision}/${templateKind}`;
  const fileName = `${artifactId}.${extension}`;

  return Object.freeze({
    artifact_id: artifactId,
    task_id: input.task_id,
    task_revision: input.task_revision,
    template_kind: templateKind,
    artifact_version: artifactVersion,
    file_extension: extension,
    mime_type: TEMPLATE_KIND_MIME_TYPES[templateKind],
    final_path: `${directory}/${fileName}`,
    staging_path: `${directory}/.staging/${artifactId}.tmp-${stagingAttempt}`,
    expected_content_digest: expectedDigest,
  });
}

/** 计划所在目录（`final_path` 的父目录）；供落盘端口建目录用。 */
export function artifactDirectoryOf(plan: ArtifactPlan): string {
  const separator = plan.final_path.lastIndexOf('/');
  return separator < 0 ? '' : plan.final_path.slice(0, separator);
}

/** 计划临时文件所在目录（`.staging/`）；供落盘端口建目录用。 */
export function stagingDirectoryOf(plan: ArtifactPlan): string {
  const separator = plan.staging_path.lastIndexOf('/');
  return separator < 0 ? '' : plan.staging_path.slice(0, separator);
}
