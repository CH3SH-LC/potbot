/**
 * 能力矩阵闸门：**没有一项已核实能力就不得签发真机凭证**。
 *
 * M01 的诚实结论是「全部 unverified」（登录门禁下拿不到任何官方 endpoint / scope）。
 * 本闸门把这个结论变成**机读的结构性拒绝**：诚实默认矩阵下，任何签发尝试都抛
 * `capability_matrix_unverified`。因此 fixture 通道无法用自造对象"证明"真机通道已接通。
 *
 * 一条 `verified` 能力必须带**非空证据引用**才算数（无证据不得声明可用，照 M10 校验器）。
 * 输入类型宽松（见 `types.ts` 的 `CapabilityMatrixInput`）以原样接受 M10 `CapabilityMatrix`；
 * 每一处字段都在这里运行期校验。
 */

import { TransportAttestationError } from './errors.js';
import { CAPABILITY_AVAILABILITIES, type CapabilityMatrixInput } from './types.js';

/** 运行期把任意矩阵输入收敛为 `Record<string, unknown> | null`。 */
function readVerdicts(matrix: CapabilityMatrixInput): Record<string, unknown> | null {
  if (matrix === null || matrix === undefined || typeof matrix !== 'object') return null;
  const raw = (matrix as { verdicts?: unknown }).verdicts;
  if (raw === null || typeof raw !== 'object') return null;
  return raw as Record<string, unknown>;
}

/**
 * 矩阵中**确实核实**的能力键（`availability === 'verified'` 且 `evidenceRef` 非空）。
 * 非法 / 缺字段 / 未核实的条目不计数。
 */
export function verifiedCapabilities(matrix: CapabilityMatrixInput): readonly string[] {
  const verdicts = readVerdicts(matrix);
  if (verdicts === null) return Object.freeze([]);
  const found: string[] = [];
  for (const [capability, raw] of Object.entries(verdicts)) {
    if (raw === null || typeof raw !== 'object') continue;
    const verdict = raw as { availability?: unknown; evidenceRef?: unknown };
    if (typeof verdict.availability !== 'string') continue;
    if (!(CAPABILITY_AVAILABILITIES as readonly string[]).includes(verdict.availability)) continue;
    if (verdict.availability !== 'verified') continue;
    const ref = verdict.evidenceRef;
    if (typeof ref === 'string' && ref.trim() !== '') {
      found.push(capability);
    }
  }
  return Object.freeze(found);
}

/** 矩阵里是否至少有一项**带证据**的已核实能力。 */
export function hasVerifiedCapability(matrix: CapabilityMatrixInput): boolean {
  return verifiedCapabilities(matrix).length > 0;
}

/**
 * 断言"当前能力矩阵允许签发真机凭证"。
 *
 * 不满足（缺矩阵 / 全部 unverified / 只有 denied / verified 却无证据引用）一律抛
 * `capability_matrix_unverified`——这是"无真实 endpoint 就签发不出 real 凭证"的唯一闸门。
 */
export function assertCapabilitySupportsRealMint(matrix: CapabilityMatrixInput): void {
  if (!hasVerifiedCapability(matrix)) {
    throw new TransportAttestationError(
      'capability_matrix_unverified',
      '能力矩阵没有一项已核实（verified + 非空证据引用）：M01 尚未确认任何真实 endpoint/scope，不得签发 real 凭证；fixture 与真实通道不得混同',
    );
  }
}
