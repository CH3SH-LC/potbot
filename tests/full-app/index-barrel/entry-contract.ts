/**
 * `src/index.ts`（内核包入口）**入口字段一致性判据**的可测实现。
 *
 * 本文件是纯函数层：只回答"给定一份 `package.json` 的对象形态，它的入口字段与
 * 内核源入口 `src/index.ts` 是否一致"，**不**读取磁盘、**不**判断是否通过。
 * 磁盘读取与断言都在 `index-barrel.test.ts`。
 *
 * ## 口径（写死，避免"看起来像判据"）
 *
 * 1. 只在 `package.json` **确实声明了**入口字段（`main` / `module` / `types` / `exports`）
 *    时才可能报红。四个字段一个都没声明 ⇒ 无违规。这是**被登记的现状**
 *    （见 `index-barrel.test.ts` §1：本包 `private: true`，没有声明任何入口字段，
 *    所以 `src/index.ts` 当前**不是任何解析路径的终点**）。
 * 2. 声明了就必须与本文件对齐：
 *    - 指向 `src/` 下**其它**模块的说明符 ⇒ 报红（入口被绕过）；
 *    - 没有任何说明符解析到内核入口（`…/src/index.{ts,js,mjs,cjs}`，含构建产物形态）⇒ 报红。
 * 3. `exports` 的**子路径映射**（如 `"./package.json": "./package.json"`）不在 `src/` 下，
 *    按规则 2 不单独报红；但"至少有一个说明符落在内核入口上"的门仍然要过。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

/** 内核**源**入口（相对仓库根）。 */
export const KERNEL_SOURCE_ENTRY = 'src/index.ts';

/**
 * 内核入口的**可接受路径形态**：任意前缀 + `src/index.{ts,js,mjs,cjs}`。
 * 这样同一判据同时覆盖"指向源码"与"指向构建产物"（本仓库 demo 构建输出为
 * `.runtime/mobile-word-demo/build/src/index.js`，见 `tsconfig.demo.json` 的 outDir）。
 */
export const KERNEL_ENTRY_PATH_RE = /(^|\/)src\/index\.(ts|js|mjs|cjs)$/;

export const ENTRY_FIELDS = ['main', 'module', 'types', 'exports'] as const;
export type EntryField = (typeof ENTRY_FIELDS)[number];

function normalizeSpecifier(spec: string): string {
  return spec.replace(/\\/g, '/').replace(/^\.\//, '');
}

function flattenSpecifiers(value: unknown, acc: string[]): void {
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenSpecifiers(item, acc);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) flattenSpecifiers(item, acc);
  }
}

/** 声明了哪些入口字段（顺序固定为 `ENTRY_FIELDS`，便于断言）。 */
export function declaredEntryFields(pkg: unknown): EntryField[] {
  if (pkg === null || typeof pkg !== 'object') return [];
  const record = pkg as Record<string, unknown>;
  return ENTRY_FIELDS.filter((field) => record[field] !== undefined);
}

/** 把 `main` / `module` / `types` / `exports` 里出现的**全部**说明符拉平（含嵌套条件与数组）。 */
export function entrySpecifiers(pkg: unknown): string[] {
  if (pkg === null || typeof pkg !== 'object') return [];
  const record = pkg as Record<string, unknown>;
  const acc: string[] = [];
  for (const field of declaredEntryFields(pkg)) flattenSpecifiers(record[field], acc);
  return acc;
}

/**
 * 入口字段一致性检查（纯函数、可反向对照）。
 *
 * @returns 违规清单；**空数组 = 一致**。未声明任何入口字段时恒为空数组。
 */
export function checkEntryFieldAgreement(pkg: unknown): string[] {
  const fields = declaredEntryFields(pkg);
  if (fields.length === 0) return [];

  const specifiers = entrySpecifiers(pkg).map(normalizeSpecifier);
  const violations: string[] = [];

  for (const spec of specifiers) {
    const intoSrc = /(^|\/)src\//.test(spec);
    if (intoSrc && !KERNEL_ENTRY_PATH_RE.test(spec)) {
      violations.push(`入口字段指向 src/ 下的其它模块（应为 src/index.*）：${spec}`);
    }
  }

  if (!specifiers.some((spec) => KERNEL_ENTRY_PATH_RE.test(spec))) {
    violations.push(
      `已声明入口字段（${fields.join(' / ')}），但没有任何说明符解析到内核入口 ` +
        `${KERNEL_SOURCE_ENTRY}（或构建产物 …/src/index.js）：[${specifiers.join(', ')}]`,
    );
  }

  return violations;
}
