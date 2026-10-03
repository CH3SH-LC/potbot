/**
 * RES-01 —— **真实查询端口**的抽象（联网检索的依赖注入边界）。
 *
 * 三条不可协商的纪律（任务书 RES-01 原文）：
 * 1. **端口未装配 ⇒ 结构化"未就绪 + 原因 + 解锁条件"**，绝不抛错、绝不 500；
 * 2. **绝不把模型已有知识当已联网检索**——每个结论都带 `fromModelKnowledge: false`，
 *    且**只有** `kind === 'network'` 的真实端口才被接受；模型路由器之类的伪装端口一律按未就绪处理；
 * 3. 端口未装配时**返回不了任何结果**（`results` 字段根本不存在），因此不存在
 *    "编造命中"的代码路径。
 *
 * 本模块**不实现任何网络调用**：真实出站由宿主（App / 后台内核）实现 `QueryPort` 注入。
 * 产品运行链上没有端口时，本模块如实报"未就绪"。本文件不含 `node:fs` / 墙钟 / 随机。
 */
import type { ClockPort } from './ports.js';

/** 查询形态：关键词 或 自然语言。 */
export type QueryMode = 'keyword' | 'natural-language';

/** 时效约束（RES-01「时效」）。时间一律用 ISO 8601 字符串，避免时区歧义。 */
export interface TimeframeConstraint {
  /** 只接受不早于此日期的内容（ISO 8601）。 */
  readonly publishedAfter?: string;
  /** 只接受不晚于此日期的内容（ISO 8601）。 */
  readonly publishedBefore?: string;
  /** 要求内容在最近 N 天内（与上面两者可并存，取更严者由端口负责）。 */
  readonly freshnessDays?: number;
}

/** 站点与范围约束（RES-01「站点/范围」）。 */
export interface QueryConstraints {
  readonly timeframe?: TimeframeConstraint;
  /** 限定站点（域名）；空数组视为不限定。 */
  readonly sites?: readonly string[];
  /** 检索范围：仅互联网 / 仅私有资料 / 不限。 */
  readonly scope?: 'web' | 'private' | 'any';
  /** 语言偏好（BCP-47 或 'zh'/'en'）。 */
  readonly language?: string;
  /** 结果条数上限。 */
  readonly limit?: number;
}

/** 一次查询请求。 */
export interface QueryRequest {
  readonly query: string;
  readonly mode: QueryMode;
  readonly constraints?: QueryConstraints;
}

/** 真实端口返回的原始命中。**本模块不生成、不改写**其中的任何字段。 */
export interface RawResult {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly site: string | null;
  readonly publishedAt: string | null;
}

/**
 * 真实联网查询端口 —— 由宿主实现。
 * `kind` 固定为 `'network'`：这是"真实检索"的身份标记，运行时仍会复核（见 `isRealNetworkPort`）。
 */
export interface QueryPort {
  readonly id: string;
  readonly kind: 'network';
  search(request: QueryRequest): Promise<readonly RawResult[]>;
}

/** 未就绪（端口未装配 / 伪端口）—— 带原因与解锁条件。 */
export interface QueryNotReady {
  readonly status: 'not-ready';
  readonly reason: string;
  readonly unlock: readonly string[];
  /** 恒为 false：未就绪状态下**没有**任何结果是由模型已有知识冒充的。 */
  readonly fromModelKnowledge: false;
}

/** 成功（真实端口返回）。 */
export interface QueryOk {
  readonly status: 'ok';
  readonly portId: string;
  readonly results: readonly RawResult[];
  readonly fromModelKnowledge: false;
}

/** 调用真实端口过程内的结构化失败（超时/网络/端口违约），同样不抛错、不 500。 */
export interface QueryFailed {
  readonly status: 'failed';
  readonly portId: string;
  readonly reason: string;
  readonly unlock: readonly string[];
  readonly fromModelKnowledge: false;
}

export type QueryOutcome = QueryOk | QueryNotReady | QueryFailed;

/** 就绪摘要（供能力发现读取）。 */
export interface QueryReadiness {
  readonly ready: boolean;
  readonly portId: string | null;
  readonly reason: string | null;
  readonly unlock: readonly string[];
}

/**
 * 端口未装配时的**固定原因**——措辞与 `not-ready.ts` 的 `research_network_port` 对齐，
 * 不新造平行说法。
 */
export const NO_PORT_REASON =
  '未装配真实查询端口：产品运行链上没有可用的联网检索实现。模型路由器（如 127.0.0.1:8008）' +
  '不是查询端口，用它作答等于"以模型已有知识冒充联网检索"，RES-01 明文禁止，故不接通。';

/** 端口未装配时的**解锁条件**（可核对、可执行）。 */
export const NO_PORT_UNLOCK: readonly string[] = Object.freeze([
  '在宿主中实现 QueryPort（kind="network"）并注入 createQueryGateway 的 port 参数',
  '提供真实检索服务凭据（API key / 端点）并由宿主保管，不写入仓库',
  '对端口做一次真实查询的端到端实测，取得回执后把该能力标为"已验证"',
]);

/** 伪端口（非真实网络）被拒绝时的原因。 */
export const PSEUDO_PORT_REASON =
  '装配的对象不是真实网络端口（kind !== "network"）：疑似以模型已有知识冒充联网检索，' +
  '按 RES-01 拒绝接通，视为未就绪。';

/**
 * 运行时复核端口身份。
 * 类型层已限定 `kind: 'network'`，但运行时仍复核——类型断言（`as QueryPort`）能绕过类型层，
 * 复核是防"以模型记忆冒充检索"的最后一道阀。
 */
export function isRealNetworkPort(port: unknown): port is QueryPort {
  if (port === null || typeof port !== 'object') {
    return false;
  }
  const candidate = port as { id?: unknown; kind?: unknown; search?: unknown };
  return (
    candidate.kind === 'network' &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.search === 'function'
  );
}

/** 校验请求本身是否合法；不合法给原因（不抛错）。 */
function validateRequest(request: QueryRequest): string | null {
  if (typeof request.query !== 'string' || request.query.trim().length === 0) {
    return '查询为空：query 必须是非空字符串';
  }
  if (request.mode !== 'keyword' && request.mode !== 'natural-language') {
    return `未知查询形态：${String(request.mode)}`;
  }
  const sites = request.constraints?.sites;
  if (sites !== undefined && sites.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
    return '站点约束含空项';
  }
  return null;
}

/** 校验端口返回的每条命中——缺地址/标题即视为端口违约。 */
function validateResults(results: readonly RawResult[]): string | null {
  for (const [index, result] of results.entries()) {
    if (result === null || typeof result !== 'object') {
      return `端口返回了非对象结果（第 ${index} 条）`;
    }
    if (typeof result.url !== 'string' || result.url.length === 0) {
      return `端口返回了无地址结果（第 ${index} 条）`;
    }
    if (typeof result.title !== 'string') {
      return `端口返回了无标题结果（第 ${index} 条）`;
    }
  }
  return null;
}

/**
 * 查询网关 —— 产品统一入口。**永远返回结构化结果，永远不抛错**。
 */
export interface QueryGateway {
  readonly ready: boolean;
  readonly portId: string | null;
  search(request: QueryRequest): Promise<QueryOutcome>;
  readiness(): QueryReadiness;
}

/**
 * 构造查询网关。
 * @param port 真实网络端口；`undefined` / `null` / 非真实端口 ⇒ 网关以"未就绪"作答。
 * @param clock 预留的时钟端口（本模块不读墙钟；端口如需只读注入）。
 */
export function createQueryGateway(port?: QueryPort | null, _clock?: ClockPort): QueryGateway {
  const real = port !== null && port !== undefined && isRealNetworkPort(port);
  const ready = real;
  const portId = real && port ? port.id : null;

  const notReady = (reason: string): QueryNotReady => ({
    status: 'not-ready',
    reason,
    unlock: NO_PORT_UNLOCK,
    fromModelKnowledge: false,
  });

  return {
    ready,
    portId,
    readiness(): QueryReadiness {
      return ready
        ? { ready: true, portId, reason: null, unlock: [] }
        : {
            ready: false,
            portId: null,
            reason:
              port === null || port === undefined
                ? NO_PORT_REASON
                : PSEUDO_PORT_REASON,
            unlock: NO_PORT_UNLOCK,
          };
    },
    async search(request: QueryRequest): Promise<QueryOutcome> {
      // 未装配真实端口：结构化未就绪——**没有** results 字段，故不可能编造命中。
      if (!ready || port === null || port === undefined) {
        return notReady(port === null || port === undefined ? NO_PORT_REASON : PSEUDO_PORT_REASON);
      }

      const invalid = validateRequest(request);
      if (invalid !== null) {
        return {
          status: 'failed',
          portId: port.id,
          reason: invalid,
          unlock: ['修正请求后重试'],
          fromModelKnowledge: false,
        };
      }

      let results: readonly RawResult[];
      try {
        results = await port.search(request);
      } catch (error) {
        return {
          status: 'failed',
          portId: port.id,
          reason: `真实端口调用失败：${(error as Error).message}`,
          unlock: NO_PORT_UNLOCK,
          fromModelKnowledge: false,
        };
      }

      if (!Array.isArray(results)) {
        return {
          status: 'failed',
          portId: port.id,
          reason: '端口违约：search 未返回数组',
          unlock: NO_PORT_UNLOCK,
          fromModelKnowledge: false,
        };
      }

      const breach = validateResults(results);
      if (breach !== null) {
        return {
          status: 'failed',
          portId: port.id,
          reason: `端口违约：${breach}`,
          unlock: NO_PORT_UNLOCK,
          fromModelKnowledge: false,
        };
      }

      const limit = request.constraints?.limit;
      const bounded =
        limit !== undefined && limit >= 0 ? results.slice(0, limit) : results;

      return { status: 'ok', portId: port.id, results: bounded, fromModelKnowledge: false };
    },
  };
}
