/**
 * **W09 / W-I16 独立验证——`fonts.ts` 必须能被 Node「仅类型擦除」加载**。
 *
 * 背景（W-R03 的真实阻塞）：`src/mobile-plugins/word/rendering/fonts.ts` 原用 TS **参数属性**
 * （`constructor(private readonly port: ...)`）。Node 的 `--experimental-strip-types` 只做类型
 * 擦除、不做代码改写，参数属性需要**生成赋值语句**，因此会抛
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；任何想裸跑本线源码的 Node 宿主（如 W-R03 的 CJK CLI）
 * 只能被迫加 `--experimental-transform-types`。本测试钉住该约束：`fonts.ts` 必须能用
 * **strip-only** 加载，且解析行为不变。
 *
 * 两层证据：
 * 1. vitest 直接实例化 `FontResolver`，断言解析结果（可用 / 替代 / 去重 / 失败）与改前一致；
 * 2. 起一个**真实子进程** `node --experimental-strip-types`，加载 `fonts.ts`（用 data: URL 的
 *    `.js`→`.ts` 解析钩子补 Node 不做的说明符回退），实例化并断言，退出码 0。
 *    子进程**不带** `--experimental-transform-types`——这正是本单元要证明的点。
 *
 * 未验证层：真机 / 真实字体表 / WPS-Word 消费端；本测试只到 **unit** 层（夹具端口）。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FontResolver } from '../../../../src/mobile-plugins/word/rendering/fonts.js';
import { LayoutError } from '../../../../src/mobile-plugins/word/rendering/errors.js';
import type {
  FontMetricsPort,
  LayoutDiagnostic,
  Twips,
} from '../../../../src/mobile-plugins/word/rendering/index.js';

/** 本夹具「端口可度量」的字体族。 */
const AVAILABLE = ['Fixture Serif', 'Fixture Fallback'] as const;

/** 确定性夹具端口（不代表任何真机字体覆盖）。 */
function createPort(): FontMetricsPort {
  const set = new Set<string>(AVAILABLE);
  return {
    hasFont: (family: string): boolean => set.has(family),
    hasGlyph: () => true,
    advanceWidthTwips: (_f: string, _cp: number, sizeTwips: Twips): Twips => sizeTwips / 2,
    ascentTwips: (_f: string, sizeTwips: Twips): Twips => sizeTwips,
    descentTwips: (): Twips => 0,
  };
}

describe('FontResolver exports & resolution behaviour (unchanged after de-parameterisation)', () => {
  it('exports the class and resolves an available family without substitution', () => {
    expect(typeof FontResolver).toBe('function');
    const diagnostics: LayoutDiagnostic[] = [];
    const resolver = new FontResolver(createPort(), undefined, diagnostics);

    const res = resolver.resolve('Fixture Serif');
    expect(res).toEqual({ family: 'Fixture Serif', substituted: false });
    expect(diagnostics).toEqual([]);
  });

  it('substitutes a missing family through the strategy and reports font_substituted', () => {
    const diagnostics: LayoutDiagnostic[] = [];
    const resolver = new FontResolver(
      createPort(),
      (requested) => (requested === 'Missing Sans' ? 'Fixture Fallback' : null),
      diagnostics,
    );

    const res = resolver.resolve('Missing Sans');
    expect(res).toEqual({ family: 'Fixture Fallback', substituted: true });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'font_substituted',
      severity: 'warning',
      requestedFont: 'Missing Sans',
      substitutedFont: 'Fixture Fallback',
    });
  });

  it('de-duplicates diagnostics per requested family while still substituting each time', () => {
    const diagnostics: LayoutDiagnostic[] = [];
    const resolver = new FontResolver(
      createPort(),
      () => 'Fixture Fallback',
      diagnostics,
    );

    expect(resolver.resolve('Missing Sans')).toEqual({ family: 'Fixture Fallback', substituted: true });
    expect(resolver.resolve('Missing Sans')).toEqual({ family: 'Fixture Fallback', substituted: true });
    expect(resolver.resolve('Another Missing')).toEqual({ family: 'Fixture Fallback', substituted: true });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.requestedFont)).toEqual(['Missing Sans', 'Another Missing']);
  });

  it('fails closed with font_missing when the strategy returns null', () => {
    const resolver = new FontResolver(createPort(), () => null, []);
    expect(() => resolver.resolve('Missing Sans')).toThrowError(LayoutError);
    try {
      resolver.resolve('Missing Sans');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LayoutError);
      expect((err as LayoutError).code).toBe('font_missing');
      expect((err as LayoutError).detail).toEqual({ requestedFont: 'Missing Sans' });
    }
  });

  it('fails closed when no substitute strategy is supplied', () => {
    const resolver = new FontResolver(createPort(), undefined, []);
    expect(() => resolver.resolve('Missing Sans')).toThrowError(LayoutError);
  });

  it('treats a strategy that returns an unavailable candidate as missing (no silent swap)', () => {
    const diagnostics: LayoutDiagnostic[] = [];
    const resolver = new FontResolver(createPort(), () => 'Also Not Installed', diagnostics);
    expect(() => resolver.resolve('Missing Sans')).toThrowError(LayoutError);
    expect(diagnostics).toEqual([]);
  });

  it('treats a strategy that echoes the requested family as missing', () => {
    const resolver = new FontResolver(createPort(), (requested) => requested, []);
    expect(() => resolver.resolve('Missing Sans')).toThrowError(LayoutError);
  });
});

describe('fonts.ts loads under node --experimental-strip-types (no transform-types)', () => {
  it('a child `node --experimental-strip-types` fixture imports and exercises the resolver (exit 0)', () => {
    // `.js` → `.ts` 解析钩子：本仓 NodeNext 源码相对导入写 `.js`，Node 类型擦除不做该回退。
    // 钩子经 data: URL 内联注册（不新增文件），只影响本子进程。
    const hookSrc =
      'export async function resolve(s,c,n){if(s.startsWith(".")&&s.endsWith(".js"))' +
      '{try{return await n(s.slice(0,-3)+".ts",c)}catch{}}return n(s,c)}';

    // 子进程 fixture：动态 import 真实的 fonts.ts（绝对 file URL），实例化并断言。
    const fontsTsPath = fileURLToPath(
      new URL('../../../../src/mobile-plugins/word/rendering/fonts.ts', import.meta.url),
    );
    const fixture = [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      `register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hookSrc)}));`,
      `const mod = await import(pathToFileURL(${JSON.stringify(fontsTsPath)}).href);`,
      "const port = { hasFont: (f) => f === 'Fixture Serif', hasGlyph: () => true,",
      '  advanceWidthTwips: () => 1, ascentTwips: () => 1, descentTwips: () => 0 };',
      "const diagnostics = [];",
      'const r = new mod.FontResolver(port, () => null, diagnostics);',
      "const ok = r.resolve('Fixture Serif');",
      "if (ok.family !== 'Fixture Serif' || ok.substituted !== false) throw new Error('plain resolve mismatch');",
      'let threw = null;',
      "try { r.resolve('Missing Sans'); } catch (e) { threw = e; }",
      "if (!threw || threw.code !== 'font_missing') throw new Error('expected font_missing');",
      "console.log('STRIP_ONLY_FIXTURE_OK');",
    ].join('\n');

    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', fixture],
      { encoding: 'utf8' },
    );

    expect(stdout).toContain('STRIP_ONLY_FIXTURE_OK');
  }, 30_000);
});
