/**
 * M10 证据采集 —— **fixture 与真实旅程结构性分离**。
 *
 * ## 为什么不是"两个文件夹"
 *
 * 把 fixture 结果和真机结果分门别类地放，靠的是人;。本模块把这条纪律做成**类型 + 运行期
 * 双保险**：
 *
 * 1. 台账在构造时就绑定 `mode`（`fixture` / `real`），`record()` 写入的每条记录都带这个
 *    `mode`，**调用方无法传**——自己不能给自己盖章。
 * 2. `fixture` 台账**结构上无法**写入 `confirmed`，也无法写 `payment_confirmed` 阶段：
 *    只有真实平台回读才可能达到这两个值（契约不变量 1、2）。
 * 3. `real` 台账需要一枚可信 `RealTransportAttestation`，由本模块私有 `WeakSet` 登记
 *    （照 M07 `createAuthorizationRef` 的同一纪律）。形状相同但未登记的对象一律
 *    `untrusted_real_attestation`。
 * 4. 证据文本过一道**脱敏闸**：出现疑似手机号 / 密钥 / 令牌字样即拒写，防止"证据里带明文"。
 *
 * ## 明确未做
 *
 * 本模块从不发出网络请求，"真机传输凭证"也只是**登记**一份上游给出的传输事实；
 * 本批没有任何真实宿主会签发它（见 `host.ts` 的诚实存根）。
 */

import {
  EVIDENCE_MODES,
  JOURNEY_STAGES,
  mayClaimCompleted,
  type CapabilityMatrix,
  type Clock,
  type EvidenceMode,
  type EvidenceStageSummary,
  type EvidenceState,
  type EvidenceSummary,
  type JourneyEvidenceInput,
  type JourneyEvidenceRecord,
  type JourneyStage,
  type RealTransportAttestation,
  type RealTransportProof,
} from './types.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const EVIDENCE_ERROR_CODES = [
  'fixture_cannot_claim_confirmed',
  'fixture_cannot_record_payment',
  'untrusted_real_attestation',
  'secret_like_text_rejected',
  'invalid_amount',
  'invalid_input',
] as const;
export type EvidenceErrorCode = (typeof EVIDENCE_ERROR_CODES)[number];

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  constructor(code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 真机传输凭证（模块私有 WeakSet 登记）
// ---------------------------------------------------------------------------

const TRUSTED_ATTESTATIONS = new WeakSet<object>();

/**
 * 签发真机传输凭证。
 *
 * 纪律：只有**确实在真机上以真实网络发出过请求**才应调用（将来由 M02 交付的真实宿主
 * 调用）。本包**不**自己调用它——`createRealFeatureHost` 直接抛 `real_host_not_wired`。
 */
export function issueRealTransportAttestation(
  proof: RealTransportProof,
  issuedAt: number,
): RealTransportAttestation {
  if (proof === null || typeof proof !== 'object') {
    throw new EvidenceError('invalid_input', '真机传输凭证需要一份 proof 对象');
  }
  if (proof.verificationMode !== 'real') {
    throw new EvidenceError(
      'invalid_input',
      `真机传输凭证的 verificationMode 必须是 "real"，收到 ${JSON.stringify(proof.verificationMode)}`,
    );
  }
  for (const key of ['deviceRef', 'requestHostRef', 'transportEvidenceRef'] as const) {
    const value = proof[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new EvidenceError('invalid_input', `真机传输凭证缺少 ${key}（不得为空）`);
    }
    assertRedacted(value, `proof.${key}`);
  }
  if (!Number.isFinite(issuedAt)) {
    throw new EvidenceError('invalid_input', `issuedAt 必须是有限数，收到 ${String(issuedAt)}`);
  }
  const attestation: RealTransportAttestation = Object.freeze({
    proof: Object.freeze({ ...proof }),
    issuedAt,
  });
  TRUSTED_ATTESTATIONS.add(attestation);
  return attestation;
}

/** 该对象是否是本模块签发的可信凭证（形状相同的伪造对象返回 false）。 */
export function isTrustedRealTransportAttestation(value: unknown): value is RealTransportAttestation {
  return typeof value === 'object' && value !== null && TRUSTED_ATTESTATIONS.has(value);
}

// ---------------------------------------------------------------------------
// 脱敏闸
// ---------------------------------------------------------------------------

/** 疑似手机号（中国大陆手机号形态）。 */
const PHONE_LIKE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
/** 疑似密钥/令牌字样。 */
const SECRET_LIKE = /(bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9]{8,}|api[_-]?key\s*[:=]|token\s*[:=]\s*[a-z0-9._-]{8,})/i;

/** 文本是否疑似含未脱敏敏感信息（供测试与调用方预检）。 */
export function containsSecretLikeText(text: string): boolean {
  return PHONE_LIKE.test(text) || SECRET_LIKE.test(text);
}

function assertRedacted(text: string, label: string): void {
  if (containsSecretLikeText(text)) {
    throw new EvidenceError(
      'secret_like_text_rejected',
      `${label} 疑似含未脱敏敏感信息（手机号/密钥/令牌）：证据与凭证必须脱敏`,
    );
  }
}

// ---------------------------------------------------------------------------
// 台账
// ---------------------------------------------------------------------------

export interface EvidenceLedger {
  readonly mode: EvidenceMode;
  /** 真实台账持有可信凭证；fixture 台账恒为 `null`。 */
  readonly attestation: RealTransportAttestation | null;
  record(input: JourneyEvidenceInput): JourneyEvidenceRecord;
  all(): readonly JourneyEvidenceRecord[];
  byStage(stage: JourneyStage): readonly JourneyEvidenceRecord[];
  summary(): EvidenceSummary;
}

export interface FixtureEvidenceLedgerConfig {
  readonly clock: Clock;
}

export interface RealEvidenceLedgerConfig {
  readonly clock: Clock;
  readonly attestation: RealTransportAttestation;
}

/** 造一个 **fixture** 证据台账：结构上写不了 `confirmed` / `payment_confirmed`。 */
export function createFixtureEvidenceLedger(config: FixtureEvidenceLedgerConfig): EvidenceLedger {
  if (config === null || typeof config !== 'object' || typeof config.clock?.now !== 'function') {
    throw new EvidenceError('invalid_input', 'fixture 台账需要注入时钟');
  }
  return makeLedger({ mode: 'fixture', clock: config.clock, attestation: null });
}

/**
 * 造一个 **real** 证据台账。凭证必须来自 {@link issueRealTransportAttestation}
 * 的登记（伪造对象 ⇒ `untrusted_real_attestation`）。
 */
export function createRealEvidenceLedger(config: RealEvidenceLedgerConfig): EvidenceLedger {
  if (config === null || typeof config !== 'object' || typeof config.clock?.now !== 'function') {
    throw new EvidenceError('invalid_input', 'real 台账需要注入时钟');
  }
  if (!isTrustedRealTransportAttestation(config.attestation)) {
    throw new EvidenceError(
      'untrusted_real_attestation',
      'real 台账需要可信的真机传输凭证；形状相同的自造 / 拷贝对象不被承认',
    );
  }
  return makeLedger({ mode: 'real', clock: config.clock, attestation: config.attestation });
}

interface LedgerInit {
  readonly mode: EvidenceMode;
  readonly clock: Clock;
  readonly attestation: RealTransportAttestation | null;
}

function makeLedger(init: LedgerInit): EvidenceLedger {
  if (!(EVIDENCE_MODES as readonly string[]).includes(init.mode)) {
    throw new EvidenceError('invalid_input', `证据模式非法：${String(init.mode)}`);
  }
  const records: JourneyEvidenceRecord[] = [];
  let sequence = 0;

  const ledger: EvidenceLedger = {
    mode: init.mode,
    attestation: init.attestation,
    record(input: JourneyEvidenceInput): JourneyEvidenceRecord {
      if (input === null || typeof input !== 'object') {
        throw new EvidenceError('invalid_input', '证据输入必须是对象');
      }
      if (!(JOURNEY_STAGES as readonly string[]).includes(input.stage)) {
        throw new EvidenceError('invalid_input', `未知阶段：${String(input.stage)}`);
      }
      const amountMinor = input.amountMinor ?? null;
      if (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || amountMinor < 0)) {
        throw new EvidenceError('invalid_amount', `金额必须是非负安全整数（最小单位），收到 ${String(amountMinor)}`);
      }

      // —— 结构性闸门：fixture 不得声称完成 / 不得记录支付 ——
      if (init.mode === 'fixture') {
        // 支付阶段先判：fixture 根本不该触碰支付，哪怕 observedState 不是 confirmed。
        if (input.stage === 'payment_confirmed') {
          throw new EvidenceError(
            'fixture_cannot_record_payment',
            'fixture 台账不得记录 payment_confirmed：fixture 无支付能力，也不得伪造支付确认',
          );
        }
        if (mayClaimCompleted(input.observedState)) {
          throw new EvidenceError(
            'fixture_cannot_claim_confirmed',
            'fixture 台账不得写入 confirmed：只有真实平台回读才可声称外部动作已完成（契约不变量 1/2）',
          );
        }
      }

      // —— 脱敏闸：任何自由文本字段都不许夹带明文 ——
      const textFields: readonly [string, string | null | undefined][] = [
        ['detail', input.detail],
        ['requestRef', input.requestRef],
        ['externalOrderId', input.externalOrderId],
        ['accountRef', input.accountRef],
        ['quoteRef', input.quoteRef],
        ['paramsDigest', input.paramsDigest],
        ['errorReason', input.errorReason],
      ];
      for (const [label, value] of textFields) {
        if (typeof value === 'string' && value.length > 0) {
          assertRedacted(value, label);
        }
      }

      sequence += 1;
      const record: JourneyEvidenceRecord = Object.freeze({
        recordId: `${init.mode}-${String(sequence).padStart(4, '0')}`,
        journeyId: input.journeyId,
        mode: init.mode,
        stage: input.stage,
        observedState: input.observedState,
        requestRef: input.requestRef ?? null,
        externalOrderId: input.externalOrderId ?? null,
        accountRef: input.accountRef ?? null,
        amountMinor,
        currency: input.currency ?? null,
        quoteRef: input.quoteRef ?? null,
        paramsDigest: input.paramsDigest ?? null,
        observedAt: init.clock.now(),
        detail: input.detail,
        errorReason: input.errorReason ?? null,
      });
      records.push(record);
      return record;
    },
    all(): readonly JourneyEvidenceRecord[] {
      return Object.freeze([...records]);
    },
    byStage(stage: JourneyStage): readonly JourneyEvidenceRecord[] {
      return Object.freeze(records.filter((record) => record.stage === stage));
    },
    summary(): EvidenceSummary {
      return summarize(init.mode, records);
    },
  };
  return Object.freeze(ledger);
}

function summarize(mode: EvidenceMode, records: readonly JourneyEvidenceRecord[]): EvidenceSummary {
  const stages: EvidenceStageSummary[] = JOURNEY_STAGES.map((stage) => {
    const latest = records.filter((record) => record.stage === stage).at(-1) ?? null;
    return Object.freeze({
      stage,
      present: latest !== null,
      observedState: latest?.observedState ?? null,
      detail: latest?.detail ?? null,
    });
  });
  return Object.freeze({
    mode,
    journeyId: records.at(-1)?.journeyId ?? null,
    total: records.length,
    stages: Object.freeze(stages),
    allStagesPresent: stages.every((stage) => stage.present),
    confirmedCount: records.filter((record) => record.observedState === 'confirmed').length,
  });
}

/** 台账里是否存在任何 `confirmed` 证据（供上层判断"是否真的外部完成"）。 */
export function hasConfirmedEvidence(ledger: EvidenceLedger): boolean {
  return ledger.all().some((record) => record.observedState === 'confirmed');
}

/** 便利：断言一个宿主/能力矩阵的组合不会把 fixture 证据当真实证据（见 `host.ts` 用法）。 */
export function assertEvidenceMatchesMode(ledger: EvidenceLedger, expected: EvidenceMode): void {
  if (ledger.mode !== expected) {
    throw new EvidenceError(
      'invalid_input',
      `证据模式不符：台账为 ${ledger.mode}，期望 ${expected}`,
    );
  }
}

/** 供上报使用的能力矩阵摘要（**不是**证据，也不签发任何回执）。 */
export function scopeSummary(matrix: CapabilityMatrix): Readonly<Record<string, EvidenceState | string>> {
  const summary: Record<string, string> = {};
  for (const [capability, verdict] of Object.entries(matrix.verdicts)) {
    summary[capability] = verdict.availability;
  }
  return Object.freeze(summary);
}
