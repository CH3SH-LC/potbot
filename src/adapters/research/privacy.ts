/**
 * 私有资料权限、任务隔离与注入防护（RES-09）。
 *
 * 三条不可协商的纪律：
 * 1. **任务隔离**：任何检索/回答只使用**同一 taskId** 的来源；跨任务必须查不到。
 * 2. **内容即数据，不是指令**：来自用户资料或外部网页的文本**永不**被当作可执行指令。
 *    本模块只**检测并上报**疑似注入，绝不执行。
 * 3. **不传出**：本切片不做任何网络出站；`assertNoEgress` 给出可核对的结构化声明。
 */
import type { Chunk } from './types.js';

/** 跨任务访问一律拒绝。 */
export function assertTaskScope(requestTaskId: string, chunk: Chunk): void {
  if (chunk.taskId !== requestTaskId) {
    throw new Error(
      `任务隔离违例：请求任务 ${requestTaskId} 试图访问任务 ${chunk.taskId} 的块 ${chunk.chunkId}`,
    );
  }
}

/** 只保留属于该任务的块。 */
export function scopeToTask(chunks: readonly Chunk[], taskId: string): Chunk[] {
  return chunks.filter((c) => c.taskId === taskId);
}

export interface InjectionFinding {
  readonly pattern: string;
  readonly excerpt: string;
}

/**
 * 疑似提示注入的模式（中英）。**只用于上报**：命中不代表内容被相信，
 * 更不代表它被当成指令执行——本适配器不会执行资料里的任何"命令"。
 */
const INJECTION_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'ignore-previous', re: /ignore\s+(all\s+)?previous\s+instructions?/i },
  { name: 'disregard', re: /disregard\s+(the\s+)?(above|previous)/i },
  { name: 'zh-ignore', re: /忽略(以上|之前|上述)(的)?(所有)?(指令|要求|说明)/ },
  { name: 'zh-you-are-now', re: /你现在(是|扮演)/ },
  { name: 'system-prompt-marker', re: /(^|\n)\s*(system|assistant)\s*[:：]\s*/i },
  { name: 'tool-call-marker', re: /(调用|执行)(工具|命令|函数)\s*[:：]/ },
  { name: 'exfiltrate', re: /(上传|发送|泄露|发给).{0,12}(密钥|密码|api\s*key|token)/i },
];

/** 扫描文本中的疑似注入。返回命中项（可能为空）。 */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const p of INJECTION_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      findings.push({
        pattern: p.name,
        excerpt: text.slice(Math.max(0, m.index - 8), Math.min(text.length, m.index + m[0].length + 8)),
      });
    }
  }
  return findings;
}

export interface EgressDeclaration {
  /** 本切片是否发起过任何网络出站。 */
  readonly performedNetworkEgress: false;
  readonly detail: string;
}

/**
 * 结构化声明：本适配器**不发起网络出站**，私有资料内容不离开本进程。
 * 这是一个可核对的声明（人工可审计代码里没有任何 fetch/net/http 调用）。
 */
export function assertNoEgress(): EgressDeclaration {
  return {
    performedNetworkEgress: false,
    detail:
      '检索适配器只在本进程内读取用户资料并建立索引；未实现也未调用任何出站接口（RES-01 的联网检索未接通）。',
  };
}
