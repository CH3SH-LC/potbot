/**
 * **W-R03 CLI**——不用起 vitest，直接 `node` 跑一遍中文字体替代解析并打印报告。
 *
 * 用法（Node ≥ 24，默认类型擦除，无需 tsx / 编译）：
 * ```
 * node tests/mobile-office/word/W-R03/run-cjk-demo.ts demo       # 打印四类场景的报告
 * node tests/mobile-office/word/W-R03/run-cjk-demo.ts selftest   # 断言不变量，退出码 0/1
 * ```
 *
 * 退出码：0 = 通过，1 = 不变量被破坏，2 = 用法错。
 *
 * ## 为什么用动态 `import(URL(...))`
 *
 * 与 W-R05 同因：`module: NodeNext` 要求源码相对导入写 `.js`，而 Node 类型擦除不做
 * `.js` → `.ts` 回退。故类型用 `typeof import('./cjk/index.js')`（tsc 认、运行时零导入），
 * 运行时用非字面量说明符 `import(URL(...))` 指向真实 `.ts`。
 * 本文件是**测试侧宿主**，允许 `node:process`；核心 `cjk/**` 保持零 `node:*` 依赖。
 */

import { register } from 'node:module';

import type { CjkSubstitutionOptions, FontSlotSet } from './cjk/index.js';

register(new URL('./ts-specifier-hooks.mjs', import.meta.url));

type CjkModule = typeof import('./cjk/index.js');
type FixtureModule = typeof import('./test-support/fixture-font-port.js');

async function load<T>(relative: string): Promise<T> {
  return (await import(new URL(relative, import.meta.url).href)) as T;
}

function fonts(partial: Partial<FontSlotSet>): FontSlotSet {
  return { ascii: null, hAnsi: null, eastAsia: null, cs: null, ...partial };
}

interface Scenario {
  readonly name: string;
  readonly run: { text: string; sizePt: number; fonts: FontSlotSet };
  readonly overrides?: Partial<CjkSubstitutionOptions>;
}

function scenarios(): Scenario[] {
  return [
    { name: '西文原样（防假阳）', run: { text: 'ABC-123', sizePt: 12, fonts: fonts({ ascii: 'Calibri' }) } },
    { name: '字体存在但无汉字字形 ⇒ 替代', run: { text: '中中文'.repeat(20), sizePt: 12, fonts: fonts({ eastAsia: 'Calibri' }) } },
    { name: '请求字体不存在 ⇒ 替代', run: { text: '中文', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) } },
    { name: '扩展 B 无候选覆盖 ⇒ 显式缺字', run: { text: '\u{20000}', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) } },
  ];
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'demo';
  if (cmd !== 'demo' && cmd !== 'selftest') {
    process.stderr.write('usage: run-cjk-demo.ts demo | selftest\n');
    return 2;
  }

  const cjk = await load<CjkModule>('./cjk/index.ts');
  const fixtures = await load<FixtureModule>('./test-support/fixture-font-port.ts');
  const port = fixtures.createFixtureFontPort();
  const baseOptions: CjkSubstitutionOptions = {
    availableFonts: fixtures.FIXTURE_AVAILABLE_FONTS,
    fallbacks: fixtures.FIXTURE_FALLBACKS,
  };

  const results = scenarios().map((s) => {
    const impact = cjk.measureCjkLayoutImpact([s.run], port, { ...baseOptions, ...s.overrides });
    return { scenario: s.name, impact };
  });

  if (cmd === 'demo') {
    for (const { scenario, impact } of results) {
      process.stdout.write(`\n=== ${scenario} ===\n`);
      process.stdout.write(
        JSON.stringify(
          {
            decisions: impact.resolution.decisions.map((d) => ({
              char: d.char,
              U: `U+${d.codePoint.toString(16).toUpperCase()}`,
              script: d.script,
              slot: d.slot,
              requested: d.requestedFont,
              effective: d.effectiveFont,
              status: d.status,
              reason: d.reason,
            })),
            fonts: impact.resolution.fonts,
            glyphs: impact.resolution.glyphs,
            layoutDiff: impact.diff,
            skippedReasons: impact.skippedReasons,
          },
          null,
          2,
        ) + '\n',
      );
    }
    return 0;
  }

  // selftest：断言核心不变量，破坏即 1。
  const failures: string[] = [];
  const check = (cond: boolean, label: string): void => {
    if (!cond) failures.push(label);
  };

  const latin = results[0]!.impact;
  check(latin.resolution.fonts.substitutions.length === 0, '西文不应有替代');
  check(latin.resolution.glyphs.records.length === 0, '西文不应有缺字');

  const glyphAbsent = results[1]!.impact;
  check(
    glyphAbsent.resolution.glyphs.totalMissingOccurrences === 60 &&
      glyphAbsent.resolution.glyphs.distinctMissingCodePoints === 2,
    '缺字应去重：60 次出现合并为 2 个码点',
  );
  check(glyphAbsent.resolution.glyphs.complete === true, '缺字应被替代恢复');
  check(glyphAbsent.diff !== null && glyphAbsent.diff.totalLinesAfter > glyphAbsent.diff.totalLinesBefore, '替代后行数应变多');

  const fontAbsent = results[2]!.impact;
  check(fontAbsent.resolution.fonts.substitutions[0]?.reason === 'font_absent', '应为 font_absent 替代');
  check(fontAbsent.before === null, '请求字体缺失时朴素基线应排不出来');

  const unresolved = results[3]!.impact;
  check(unresolved.resolution.glyphs.complete === false, 'U+20000 应报未恢复缺字');
  check(unresolved.resolution.decisions[0]?.status === 'unresolved_glyph', 'U+20000 应为 unresolved_glyph');

  if (failures.length > 0) {
    process.stderr.write(`selftest FAILED:\n  - ${failures.join('\n  - ')}\n`);
    return 1;
  }
  process.stdout.write('selftest PASSED (10 invariants)\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
