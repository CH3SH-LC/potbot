/**
 * 检索用切词与归一化。
 *
 * 中文无空格，且本切片**不引入分词依赖**（零运行期依赖策略）。
 * 采用中文信息检索的通用做法：**CJK 二元字符组（bigram）** + 拉丁词/数字整词。
 * 这不必"正确分词"，只需稳定、可解释、可复现——它只影响排序，不影响证据原文。
 *
 * 注意：本模块的归一化**只用于匹配**，绝不用于改写正文——
 * 正文与偏移必须与原始文件一致，否则引用回读会失效（RES-05）。
 */

/** 判断是否 CJK 统一表意文字（含扩展 A）与常见全角标点外的汉字区。 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名（混排时按 CJK 处理）
    (cp >= 0xac00 && cp <= 0xd7af) // 韩文
  );
}

function isLatinWordChar(ch: string): boolean {
  return /[0-9A-Za-z_]/.test(ch);
}

/**
 * 把文本切成检索词。
 * - 拉丁：连续的 `[0-9A-Za-z_]` 作为一词，转小写；
 * - CJK：连续 CJK 串取**相邻二字组**；若整串长度 1，则保留单字。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let latin = '';
  let cjkRun: string[] = [];

  const flushLatin = (): void => {
    if (latin.length > 0) {
      out.push(latin.toLowerCase());
      latin = '';
    }
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      out.push(cjkRun[0] as string);
    } else if (cjkRun.length > 1) {
      for (let i = 0; i + 1 < cjkRun.length; i += 1) {
        out.push(`${cjkRun[i]}${cjkRun[i + 1]}`);
      }
    }
    cjkRun = [];
  };

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) {
      flushLatin();
      cjkRun.push(ch);
    } else if (isLatinWordChar(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return out;
}

/** 去重后的词集合（保持首次出现顺序，便于确定性输出）。 */
export function uniqueTerms(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/**
 * 匹配用归一化：小写化 + 折叠空白。**不改动字符本身**，故不破坏偏移假设；
 * 仅用于比较，不用于产出正文。
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[ \t\r\n　]+/g, ' ').trim();
}

/**
 * 词频表。返回 Map 以保留确定性插入顺序。
 */
export function termFrequencies(terms: readonly string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of terms) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return freq;
}
