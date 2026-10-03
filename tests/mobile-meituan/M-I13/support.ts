/**
 * M-R02 测试辅助（不是被收集的用例文件）。
 *
 * 全部场景由本地 fixture 驱动：没有网络、没有系统时间、没有权限。
 */

import type { CatalogIssue, SpecSelection } from '../../../src/mobile-plugins/meituan/spec-preflight/index.js';

/** 从问题列表取出全部 code（保持顺序）。 */
export function codesOf(issues: readonly CatalogIssue[]): readonly string[] {
  return issues.map((issue) => issue.code);
}

/** 断言某个问题码存在，并返回该问题（找不到则抛错）。 */
export function issueWithCode(issues: readonly CatalogIssue[], code: string): CatalogIssue {
  const found = issues.find((issue) => issue.code === code);
  if (found === undefined) {
    throw new Error(`期望包含问题码 ${code}，实际只有 ${codesOf(issues).join(',') || '（空）'}`);
  }
  return found;
}

/** 便捷构造规格选择。 */
export function sel(groupId: string, optionId: string): SpecSelection {
  return { groupId, optionId };
}
