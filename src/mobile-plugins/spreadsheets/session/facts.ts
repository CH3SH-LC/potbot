/**
 * **表格共享事实宿主**（XLS-18；X10 独占包）。
 *
 * ## 为什么要有这个宿主
 *
 * EXCEL.md 记的缺口是：生产 `createXlsFactsHost({})` **没有给发布通道**——"接口点存在"
 * 与"能力可用"分不开。本宿主把**通道是否装配**变成构造期就显式的一件事：
 * {@link SpreadsheetFactsHost.report} 会如实说出哪些目标已接线、哪些还是 `not-wired`。
 *
 * ## 两条边都走"有回执才算数"
 *
 * - **发布边**（表格 → 文档 / PPT）：转调 `facts-binding.publishSharedFacts`。未装配的通道
 *   逐个标 `not-wired`，`claimed_published` 恒为字面量 `false`。
 * - **消费边**（文档 / PPT → 表格）：转调 `facts-binding.consumeSharedFactSnapshot`。
 *   回执的版本 / 来源 / 引用号对不上就不认这次消费——`consumed: false`。
 *
 * 宿主自身**不发明判定**：绑定、应用、发布、消费全部复用 `facts-binding.ts`。本文件只做
 * "把端口装起来 + 把状态如实报出来"。
 *
 * ## 纪律
 *
 * 纯逻辑宿主（不含 IO）；实际落盘 / 联网由注入的端口实现，且在 `src/**` 之外。
 */

import { ValidationError } from '../../../protocol/index.js';
import type { RecalcOptions } from '../../../spreadsheets/recalc.js';
import type { WorkbookState } from '../../../spreadsheets/workbook.js';
import {
  applyFactUpdates,
  bindCell,
  bindingsForFact,
  consumeSharedFactSnapshot,
  EMPTY_BINDING_TABLE,
  PUBLICATION_TARGETS,
  publishSharedFacts,
  unbindCell,
  type CellFactBinding,
  type CrossTemplatePublishPort,
  type FactBindingTable,
  type FactCellUpdate,
  type FactUpdateApplication,
  type PublicationTarget,
  type SameVersionConsumePort,
  type SameVersionConsumptionResult,
  type SharedFactPublication,
  type SharedFactSnapshot,
  type TemplatePublicationResult,
} from '../../../spreadsheets/facts-binding.js';

/** 宿主构造参数：通道装配情况在这里一次性交代清楚。 */
export interface SpreadsheetFactsHostOptions {
  /** 跨模板发布通道（表格 → 文档 / PPT）。缺省 = 全部未接线。 */
  readonly channels?: readonly CrossTemplatePublishPort[];
  /** 同版快照消费端口（文档 / PPT → 表格）。缺省 = 未接线。 */
  readonly consumer?: SameVersionConsumePort;
  /** 初始绑定表。 */
  readonly bindings?: FactBindingTable;
  /** 重算选项（如 `TODAY()` 的当前日期）。 */
  readonly recalc?: RecalcOptions;
}

/** 宿主接线状态的如实报告。 */
export interface FactsWiringReport {
  readonly publisher_wired_targets: readonly PublicationTarget[];
  readonly publisher_unwired_targets: readonly PublicationTarget[];
  readonly consumer_wired: boolean;
  readonly consumer_id: string | null;
  readonly bound_fact_keys: readonly string[];
  /** 一句话结论：哪些边还没接。 */
  readonly summary: string;
}

/** 一次事实更新在宿主上的结果（工作簿 + 绑定表 + 应用报告）。 */
export interface HostFactApplyResult {
  readonly workbook: WorkbookState;
  readonly table: FactBindingTable;
  readonly application: FactUpdateApplication;
}

/**
 * 表格共享事实宿主。
 *
 * 绑定表可变（`bind` / `unbind` 就地更新），因此宿主是一个**有状态服务对象**——
 * 与手机侧一个长期存活的表格会话对应。
 */
export class SpreadsheetFactsHost {
  readonly #channels: readonly CrossTemplatePublishPort[];
  readonly #consumer: SameVersionConsumePort | undefined;
  readonly #recalc: RecalcOptions;
  #bindings: FactBindingTable;

  constructor(options: SpreadsheetFactsHostOptions = {}) {
    this.#channels = Object.freeze([...(options.channels ?? [])]);
    this.#consumer = options.consumer;
    this.#bindings = options.bindings ?? EMPTY_BINDING_TABLE;
    this.#recalc = options.recalc ?? {};
  }

  /** 当前绑定表（只读视图）。 */
  get bindings(): FactBindingTable {
    return this.#bindings;
  }

  /** 一个格绑定到事实键 + 版本（同格重复绑定 ⇒ 后绑者胜）。 */
  bind(binding: CellFactBinding): void {
    this.#bindings = bindCell(this.#bindings, binding);
  }

  /** 解除一个格的绑定。 */
  unbind(sheet: string, address: string): void {
    this.#bindings = unbindCell(this.#bindings, sheet, address);
  }

  /** 一个事实键绑定的全部格。 */
  boundCells(factKey: string): readonly CellFactBinding[] {
    return bindingsForFact(this.#bindings, factKey);
  }

  /** 应用一批事实更新（复用 `applyFactUpdates`；迟到 / 冲突版本被拒，不改写）。 */
  apply(workbook: WorkbookState, updates: readonly FactCellUpdate[]): HostFactApplyResult {
    const application = applyFactUpdates({
      workbook,
      table: this.#bindings,
      updates,
      recalc: this.#recalc,
    });
    this.#bindings = application.table;
    return { workbook: application.workbook, table: application.table, application };
  }

  /** 向文档 / PPT 发布同版事实（未装配的目标逐个 `not-wired`）。 */
  async publish(publications: readonly SharedFactPublication[]): Promise<readonly TemplatePublicationResult[]> {
    return publishSharedFacts({ channels: this.#channels, publications });
  }

  /** 消费一份同版快照（要求同版 + 非空回执；未装配 ⇒ `not-wired`）。 */
  async consume(snapshot: SharedFactSnapshot): Promise<SameVersionConsumptionResult> {
    return consumeSharedFactSnapshot(this.#consumer, snapshot);
  }

  /** 接线状态报告：哪些边已接、哪些没接，逐条如实。 */
  report(): FactsWiringReport {
    const total: readonly PublicationTarget[] = PUBLICATION_TARGETS;
    const wired = total.filter((target) => this.#channels.some((channel) => channel.target === target));
    const unwired = total.filter((target) => !wired.includes(target));
    const boundFactKeys = Object.freeze(
      [...new Set(this.#bindings.bindings.map((entry) => entry.fact_key))].sort(),
    );
    return Object.freeze({
      publisher_wired_targets: Object.freeze(wired),
      publisher_unwired_targets: Object.freeze(unwired),
      consumer_wired: this.#consumer !== undefined,
      consumer_id: this.#consumer?.consumer ?? null,
      bound_fact_keys: boundFactKeys,
      summary:
        (unwired.length === 0
          ? '发布边：全部目标已接线；'
          : `发布边：未接线目标 ${unwired.join(', ')}；`) +
        (this.#consumer === undefined ? '消费边：未接线。' : `消费边：已接（${this.#consumer.consumer}）。`),
    });
  }
}

/** 便捷入口。 */
export function createSpreadsheetFactsHost(
  options: SpreadsheetFactsHostOptions = {},
): SpreadsheetFactsHost {
  if (options.channels !== undefined && !Array.isArray(options.channels)) {
    throw new ValidationError('createSpreadsheetFactsHost：channels 必须是数组');
  }
  return new SpreadsheetFactsHost(options);
}
