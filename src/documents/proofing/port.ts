/**
 * 校对 / 翻译的**显式可注入端口**（design-05-P9 的收口；WF-095 / WF-096；R140 / R148 / R155）。
 *
 * ## 为什么必须有这一层
 *
 * `spelling.ts` 与 `translation.ts` 是**纯函数 + 调用方给输入**的模型层：它们不知道
 * "检查 / 翻译这件事由谁来做"。这在测试里很好，在**产品路径**上却是缺口——上层要么自己
 * 到处 import `createRuleBasedChecker` 与某个翻译器，要么在"还没有真实模型"时**悄悄降级**成
 * 一个看起来能用的空壳（"0 条提示"、"原样返回的原译文"）。
 *
 * 后者正是本项目最忌讳的一类错：**用确定性的空结果冒充"检查过了、没问题"**。
 * 因此本模块把"谁来做校对/翻译"变成一个**显式注入的端口**，并把它的**就绪状态**做成
 * 可查询的返回类型：
 *
 * | 情形 | `readiness.status` | `check(...)` 的行为 |
 * |---|---|---|
 * | 接了真实模型 | `'ready'`（`kind: 'model'`） | 逐条回到模型（**可能失败**） |
 * | 只接了显式规则表 | `'ready'`（`kind: 'deterministic_rules'`） | 按规则命中；来源**如实标成规则表** |
 * | 什么也没接 | `'not_ready'` | **`fail`**——`ok:false`，一个 `ProofingIssue` 都不产出 |
 *
 * ## "未就绪"为什么必须是 `fail` 而不是空数组
 *
 * `Result<readonly ProofingIssue[]>` 里 `ok:true` + `value:[]` 的语义是"**检查过**，没有
 * 任何问题"；`ok:false` 的语义是"**这件事没做成**"。两者在消费端要做的事完全不同
 * （前者显示"未发现错误"，后者显示"校对未就绪/不可用"）。把"没接模型"写成空数组，
 * 就是把"没做成"伪装成"没问题"——R140（先拒绝、不产出半成品）与 R148/R155（不得冒充）
 * 明令禁止。本模块的 `not_ready` 端口在类型上就**产不出**一个 `ok:true` 的检查结果。
 *
 * ## 与 `spelling.ts` / `translation.ts` 的关系
 *
 * 本模块**不重复实现**它们任何一条判据：`check` 直接委托给一个 `ProofingChecker`
 * （`spelling.ts` 的接口），`translator()` 直接给出一个 `TranslatorPort`
 * （`translation.ts` 的接口）。它是"接线 + 就绪状态"，不是第二份实现。
 */

import type { DocumentModel } from '../model/types.js';
import { fail, succeed, type Result } from '../selection/types.js';
import { createRuleBasedChecker, type ProofingChecker, type ProofingIssue, type ProofingRule } from './spelling.js';
import type { TranslatorPort } from './translation.js';

/**
 * 端口的**来源类别**。
 *
 * `deterministic_rules` **不是**真实模型：它按调用方显式给的正则/字面量命中，命中完全可复现，
 * 但**没有**任何语言模型参与。回执里必须能读出这一区别，否则"我们接了校对"这句话就是假的。
 */
export type ProofingBackendKind = 'model' | 'deterministic_rules';

/** 端口的就绪状态（**使用前可查**）。 */
export type ProofingReadiness =
  | {
      readonly status: 'ready';
      /** 提供者身份（真实模型名 / "显式规则表"）——**必须能说清是谁**。 */
      readonly provider: string;
      readonly kind: ProofingBackendKind;
    }
  | {
      readonly status: 'not_ready';
      /** 为什么没就绪（缺失配置 / 未接模型 / 显式声明不可用）——给人看的一句话。 */
      readonly reason: string;
    };

/** 一次检查请求。 */
export interface ProofingCheckInput {
  readonly model: DocumentModel;
  /** 只检查这些段落（省略 = 全文）。 */
  readonly paragraph_ids?: readonly string[];
}

/**
 * 校对 / 翻译端口。
 *
 * **两个能力各自可缺失**：一个"只有规则表、没有翻译"的端口是合法的（`kind` 如实标成
 * `deterministic_rules`，`translator()` 给 `unsupported`），而不是被拼成一个"什么都能做"的假象。
 */
export interface ProofingPort {
  readonly readiness: ProofingReadiness;
  /** 生效的规则 id（未接线时为 `[]`）——回执用，便于核对"检查的是哪套规则"。 */
  readonly rule_ids: readonly string[];
  /** 拼写 / 语法检查。**未就绪时 `fail`**，绝不返回"0 条提示"冒充检查过。 */
  check(input: ProofingCheckInput): Result<readonly ProofingIssue[]>;
  /** 取翻译端口。**未就绪 / 该端口不含翻译能力时 `fail`**，绝不返回一个原样回显的替身。 */
  translator(): Result<TranslatorPort>;
}

/**
 * 造一个**未就绪**的端口：什么能力都没有，且**如实**说清为什么。
 *
 * 这是"还没有真实模型"时的**默认答案**。它存在的意义就是让上层有一个诚实的落点：
 * 与其悄悄降级成空壳，不如显式告诉用户"校对/翻译未就绪"。
 *
 * @param reason 未就绪的原因（会原样出现在 `fail` 的 message 里，便于用户看懂）。
 */
export function createUnavailableProofingPort(reason: string): ProofingPort {
  const why =
    reason.length > 0
      ? reason
      : '本端口的就绪原因未被说明（调用方给了空字符串——原因不明也必须说"原因不明"，不编造）。';
  const unavailable = (what: string) =>
    fail(
      'precondition',
      `校对/翻译未就绪：${why}（能力：${what}）。` +
        '没有真实模型时**不得**伪造结果——这里既不返回"0 条提示"，也不返回原样回显的"译文"。',
      { extra: { proofingReadiness: 'not_ready', capability: what } },
    );
  return {
    readiness: { status: 'not_ready', reason: why },
    rule_ids: [],
    check: () => unavailable('spelling'),
    translator: () => unavailable('translation'),
  };
}

/** 接真实模型所需的两个适配器（至少接一个；都缺 = 端口没有能力，构造时拒绝）。 */
export interface ModelBackedProofingOptions {
  /** 提供者身份（**非空**）：真实模型名 / 端点标识。"无名的模型"无法在回执里被核对。 */
  readonly provider: string;
  /** 拼写 / 语法检查的适配器（`spelling.ts` 的 `ProofingChecker`）。 */
  readonly checker?: ProofingChecker;
  /** 翻译适配器（`translation.ts` 的 `TranslatorPort`）。 */
  readonly translator?: TranslatorPort;
}

/**
 * 造一个**接了真实模型**的端口（`kind: 'model'`）。
 *
 * 三条构造期约束（都在**产出任何结果之前**拒绝）：
 * 1. `provider` 必须是非空字符串——说不清是谁做的，就不算接了模型；
 * 2. `checker` 与 `translator` **至少要有一个**——两个都没有的"模型端口"是个空壳；
 * 3. 两个都没有时给 `precondition`，而不是构造出一个每次调用都失败的端口（那只会让
 *    缺口藏到运行期）。
 */
export function createModelBackedProofingPort(
  options: ModelBackedProofingOptions,
): Result<ProofingPort> {
  const provider = options.provider.trim();
  if (provider.length === 0) {
    return fail(
      'invalid_query',
      '模型校对端口必须给出非空的 provider（提供者身份）：回执要能说清"是谁检查/翻译的"。',
      { extra: { provider: options.provider } },
    );
  }
  if (options.checker === undefined && options.translator === undefined) {
    return fail(
      'precondition',
      `端口 "${provider}" 既没有检查适配器、也没有翻译适配器：这是一个空壳端口，` +
        '构造出来只会让"未接模型"藏到运行期。要么接一个能力，要么用 createUnavailableProofingPort 如实声明未就绪。',
      { extra: { provider } },
    );
  }
  const checker = options.checker;
  const translator = options.translator;
  return succeed({
    readiness: { status: 'ready', provider, kind: 'model' },
    rule_ids: checker?.rule_ids ?? [],
    check: (input) =>
      checker === undefined
        ? fail('unsupported', `端口 "${provider}" 未接拼写/语法检查能力。`, {
            extra: { provider, capability: 'spelling' },
          })
        : checker.check(input.model, input.paragraph_ids),
    translator: () =>
      translator === undefined
        ? fail('unsupported', `端口 "${provider}" 未接翻译能力。`, {
            extra: { provider, capability: 'translation' },
          })
        : succeed(translator),
  });
}

/**
 * 只接**显式规则表**的端口（`kind: 'deterministic_rules'`）。
 *
 * 这不是"模型"，但它**也不是伪造**：规则是调用方显式给的，命中可复现，回执里的
 * `kind` 会如实写成 `deterministic_rules`。翻译能力**没有**——`translator()` 给
 * `unsupported`，而不是拿一个原样回显的替身冒充"翻译结果"。
 */
export function createRuleBasedProofingPort(rules: readonly ProofingRule[]): Result<ProofingPort> {
  const checker = createRuleBasedChecker(rules);
  if (!checker.ok) return checker;
  return succeed({
    readiness: { status: 'ready', provider: '显式规则表（非真实模型）', kind: 'deterministic_rules' },
    rule_ids: checker.value.rule_ids,
    check: (input) => checker.value.check(input.model, input.paragraph_ids),
    translator: () =>
      fail(
        'unsupported',
        '本端口只接了显式规则表，没有翻译能力；不提供"原样返回原文"的替身（那不是翻译）。',
        { extra: { capability: 'translation', kind: 'deterministic_rules' } },
      ),
  });
}

/** `readiness` 是不是 `not_ready`（给调用方一个可编程的分支点，不用解析 message）。 */
export function isNotReady(port: ProofingPort): boolean {
  return port.readiness.status === 'not_ready';
}

/**
 * 使用前的**就绪闸门**：未就绪立刻 `fail`，并且**不调用端口的任何能力**。
 *
 * 为什么要有这一步：`check` / `translator` 自己也会拒绝，但上层往往在**更早**的地方
 * （弹窗、按钮可用性）就需要知道能不能做。门禁化让"未就绪"只能被显式处理，而不会
 * 被某个 `if (!result.ok) return []` 的手滑吞掉。
 */
export function requireReady(port: ProofingPort, capability: 'spelling' | 'translation'): Result<ProofingReadiness> {
  if (port.readiness.status === 'not_ready') {
    return fail(
      'precondition',
      `校对/翻译未就绪，无法执行 ${capability}：${port.readiness.reason}`,
      { extra: { capability, proofingReadiness: 'not_ready' } },
    );
  }
  return succeed(port.readiness);
}

/** 一句话回执：就绪状态 + 来源类别 + 规则数（UI / 回执里直接用）。 */
export function describeProofingReadiness(port: ProofingPort): string {
  if (port.readiness.status === 'not_ready') {
    return `校对/翻译：未就绪（${port.readiness.reason}）`;
  }
  const kind = port.readiness.kind === 'model' ? '真实模型' : '显式规则表（非模型）';
  const rules = port.rule_ids.length === 0 ? '无规则' : `${String(port.rule_ids.length)} 条规则`;
  return `校对/翻译：就绪，来源 ${port.readiness.provider}（${kind}），${rules}`;
}
