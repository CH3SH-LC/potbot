/**
 * K03 手机密钥库 —— **keyRef 发行与双重校验**（零依赖、纯函数）。
 *
 * ## keyRef 是什么，不是什么
 *
 * `keyRef` 是**引用**，不是密钥本身：`keyref:model.deepseek-flash`。UI / JS / 模型提示词 /
 * 任务台账 / 日志只能拿到这个字符串和它的状态（见 `KeyStatusView`），**拿不到原文**。
 * 真身在原生 Keystore 保护下加密存放（`apps/android/app/src/main/java/com/potbot/kernel/security/`）。
 *
 * ## 双重判据（与 K02 `normalizeKeyRef` 同源，不重复造词表）
 *
 * 1. **形状**：`^keyref:[A-Za-z0-9._:-]+$`（契约 `$defs.keyRef.pattern`）。
 * 2. **内容**：引用体再扫一遍明文密钥特征 —— 挡住 `keyref:sk-live-xxxxxxxx` 这种
 *    "形状是引用、内容是明文"的伪装。
 *
 * 只做前者会漏掉伪装；只做后者会漏掉任何自造形状的密钥。两条都要。
 */

import { SecurityError, outputContainsPlaintext } from './errors.js';

/** 契约 `$defs.keyRef.pattern`（与 `apps/mobile-kernel/model/types.ts` 逐字一致）。 */
export const KEY_REF_PATTERN = /^keyref:[A-Za-z0-9._:-]+$/;

/** 两类受管密钥（用户 2026-10-03：App key + 美团临时演示 key）。 */
export const KEY_KINDS = ['model', 'meituan'] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

/** 别名（keyRef `:` 之后的部分）的合法形状。 */
export const KEY_REF_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 每类密钥的**默认 keyRef**。K02 的模型请求只需要把 `keyRef` 原样传给 `ModelPort`，
 * 不需要知道密钥种类之外的东西。
 */
export const DEFAULT_KEY_REFS: Readonly<Record<KeyKind, string>> = Object.freeze({
  model: 'keyref:model.deepseek-flash',
  meituan: 'keyref:meituan.demo',
});

export function isKeyKind(value: unknown): value is KeyKind {
  return typeof value === 'string' && (KEY_KINDS as readonly string[]).includes(value);
}

/** 形状校验（只看 pattern；不查内容）。 */
export function isKeyRef(value: unknown): value is string {
  return typeof value === 'string' && KEY_REF_PATTERN.test(value);
}

/**
 * **发行**一个 keyRef。别名由调用方给出（通常是模型名 / 供应方名），内核不替调用方
 * 生成随机别名——随机别名不利于"同一类密钥在重启后仍指向同一个引用"。
 */
export function issueKeyRef(kind: KeyKind, alias: string): string {
  if (!(KEY_KINDS as readonly string[]).includes(kind)) {
    throw new SecurityError('invalid_key_kind', `未知密钥种类：${String(kind)}（只允许 ${KEY_KINDS.join(' / ')}）`);
  }
  if (typeof alias !== 'string' || !KEY_REF_ALIAS_PATTERN.test(alias)) {
    throw new SecurityError(
      'invalid_key_ref_alias',
      `别名不满足 ${String(KEY_REF_ALIAS_PATTERN)}（小写字母数字开头，只含 . _ -）`,
    );
  }
  const keyRef = `keyref:${kind}.${alias}`;
  // 别名本身也要过内容判据：`issueKeyRef('model','sk-live-...')` 必须被拒。
  assertKeyRef(keyRef);
  return keyRef;
}

/** 取默认 keyRef（`kind` 非法则抛）。 */
export function defaultKeyRef(kind: KeyKind): string {
  if (!(KEY_KINDS as readonly string[]).includes(kind)) {
    throw new SecurityError('invalid_key_kind', `未知密钥种类：${String(kind)}`);
  }
  return DEFAULT_KEY_REFS[kind];
}

/**
 * keyRef 的**双重**判据：形状是引用，且引用体不含明文密钥特征。非法则抛 `SecurityError`。
 */
export function assertKeyRef(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecurityError('invalid_key_ref', 'keyRef 必须是非空字符串');
  }
  if (!KEY_REF_PATTERN.test(value)) {
    throw new SecurityError(
      'invalid_key_ref',
      'keyRef 必须是 keyref: 前缀的引用（契约 pattern ^keyref:[A-Za-z0-9._:-]+$）；明文密钥不是合法 keyRef',
    );
  }
  // 引用形状下再查内容：`keyref:sk-...` 这类"引用里裹明文"必须被抓。
  const body = value.slice('keyref:'.length);
  if (outputContainsPlaintext(body)) {
    throw new SecurityError('key_ref_contains_secret', 'keyRef 形状像引用但内容带明文密钥特征（原文不落盘）');
  }
  return value;
}

/** 从 keyRef 解析出种类（前缀 `keyref:<kind>.`）；解析不出返回 null。 */
export function kindOfKeyRef(keyRef: string): KeyKind | null {
  for (const kind of KEY_KINDS) {
    if (keyRef.startsWith(`keyref:${kind}.`)) return kind;
  }
  return null;
}
