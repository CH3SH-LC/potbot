/**
 * FA-CRLF-SHEBANG-SCAN / ①根因两层证据（+ 复核层）
 *
 * 断言一个**已发生的真门禁阻塞**的根因链，全部用**机读证据**，不含模拟结论：
 *
 *   正则层：从实际安装的 vite 发行文件里抠出 `hashbangRE` 原文（并断言它就是 `/^#!.*\n/`），
 *           在 LF 上匹配长度 = 20（= `#!/usr/bin/env node\n`），在 CRLF 上 **null**
 *           ⇒ `fileStartIndex = … ?? 0` 退化为 0。
 *   变换层：真实 `vite.createServer().transformRequest(url, { ssr: true })` 产物：
 *           同内容 LF ⇒ 仍以 `#!` 开头；CRLF ⇒ 导出注册代码被插到 `#!` **之前**。
 *   加载层：真实 `server.ssrLoadModule(url)`：LF 正常求值；CRLF 抛 **SyntaxError**。
 *   复核层：vitest 自己的 mock 提升 `@vitest/mocker` 的 `hoistMocks()` 用同一正则、
 *           同一病灶（CRLF ⇒ 提升后的 `vi.mock()` 跑到 `#!` 前面）。
 *
 * 纪律：探针**不硬编码** vite 的行为，也不 mock 掉 vite —— 抠出的正则源码、发行文件路径、
 * 版本号都在断言的失败信息里可见。若上游改了实现（比如换成 `/^#!.*\r?\n/`），
 * 本测试会**红**并指出"根因已消除 / 结构已变"，而不是悄悄继续绿。
 */

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeHashbangFixtures, type FixtureSet } from './fixtures.js';
import {
  CRLF_SHEBANG_LINE,
  FIXTURE_BODY,
  LF_SHEBANG_LINE,
  observeHashbangRegex,
  observeMockerHoist,
  observeViteSsrLoad,
  resolveViaVitest,
  type MockerHoistObservation,
  type ViteLoadObservation,
} from './hashbang-probe.js';
import { resolveRepoRoot } from './shebang-scan.js';

const repoRoot = resolveRepoRoot();

/** 三层探针共用的两条同内容代码，只差行尾 */
const lfCode = LF_SHEBANG_LINE + FIXTURE_BODY;
const crlfCode = CRLF_SHEBANG_LINE + FIXTURE_BODY;

/** 复核层：含 `vi.mock(...)` 才会触发 vitest 的 mock 提升路径 */
const mockBody = 'import { vi } from "vitest";\nvi.mock("a");\nexport const marker = "ok";\n';
const mockLfCode = LF_SHEBANG_LINE + mockBody;
const mockCrlfCode = CRLF_SHEBANG_LINE + mockBody.replace(/\n/g, '\r\n');

let fixtures: FixtureSet;
let viteLoad: Awaited<ReturnType<typeof observeViteSsrLoad>>;
let mockerHoist: MockerHoistObservation[];

beforeAll(async () => {
  fixtures = makeHashbangFixtures(repoRoot);
  viteLoad = await observeViteSsrLoad(fixtures.dir, ['lf', 'crlf']);
  mockerHoist = await observeMockerHoist([
    { label: 'lf', code: mockLfCode },
    { label: 'crlf', code: mockCrlfCode },
  ]);
}, 60_000);

afterAll(() => {
  fixtures?.dispose();
});

describe('夹具自检（先证明夹具本身是它声称的样子）', () => {
  it('LF 夹具首行以 \\n 结束；CRLF 夹具首行以 \\r\\n 结束', () => {
    const lf = fs.readFileSync(fixtures.paths['lf']!);
    const crlf = fs.readFileSync(fixtures.paths['crlf']!);
    expect(lf.toString('latin1').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(crlf.toString('latin1').startsWith('#!/usr/bin/env node\r\n')).toBe(true);
    // 除行尾外内容一致 —— 排除"两份夹具内容不同"这种伪对照
    expect(lf.toString('utf8').replace(/\r\n/g, '\n')).toBe(
      crlf.toString('utf8').replace(/\r\n/g, '\n'),
    );
  });
});

describe('① 正则层 —— Vite 的 hashbangRE 在 CRLF 上失配 ⇒ fileStartIndex 退化为 0', () => {
  it('抠出的正则就是 /^#!.*\\n/（无 flags），且 dist 里确有 fileStartIndex 赋值行', () => {
    const obs = observeHashbangRegex(resolveViaVitest('vite'), lfCode, crlfCode);
    // 正则原文：JS 的 `.` 不匹配 \r，所以 CRLF 的第一行它看不见
    expect(obs.regexSource).toBe('^#!.*\\n');
    expect(obs.literal).toBe('/^#!.*\\n/');
    expect(obs.fileStartIndexLine).toBe(
      'const fileStartIndex = hashbangRE.exec(code)?.[0].length ?? 0;',
    );
    expect(fs.existsSync(obs.modulePath)).toBe(true);
    // 钉住证据来源：确实来自 vite 的发行目录（不是测试里手写的正则）
    expect(obs.modulePath.replace(/\\/g, '/')).toMatch(/\/vite\/dist\/node\//);
  });

  it('LF 匹配长度 = 20（整行）；CRLF 匹配为 null ⇒ fileStartIndex 0 vs 20', () => {
    const obs = observeHashbangRegex(resolveViaVitest('vite'), lfCode, crlfCode);
    expect(LF_SHEBANG_LINE.length).toBe(20);
    expect(obs.matchedLf).toBe(true);
    expect(obs.matchLengthLf).toBe(20);
    expect(obs.fileStartIndexLf).toBe(20);
    expect(obs.matchedCrlf).toBe(false);
    expect(obs.matchLengthCrlf).toBeNull();
    expect(obs.fileStartIndexCrlf).toBe(0);
  });

  it('病根是 JS 语义而非 vite 写错：/^#!.*\\n/ 在 CRLF 上确实不匹配（对照 LF）', () => {
    // 直接跑等价正则，把"为什么"钉在语言语义上（`.` 不匹配 \r）
    expect(/^#!.*\n/.test(lfCode)).toBe(true);
    expect(/^#!.*\n/.test(crlfCode)).toBe(false);
    // 若哪天上游改成 \r?\n，本行会变红 —— 说明根因已变，应复核本测试
    expect(/^#!.*\r?\n/.test(crlfCode)).toBe(true);
  });
});

describe('② 变换层 —— 真实 Vite SSR 变换把导出注册插到 #! 之前', () => {
  it('vite 版本可读（证据绑定到具体版本）', () => {
    expect(viteLoad.viteVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('LF 产物仍以 #! 开头；CRLF 产物以 __vite_ssr_exportName__ 开头（#! 被顶到后面）', () => {
    const lf = viteLoad.rest.find((o) => o.label === 'lf') as ViteLoadObservation;
    const crlf = viteLoad.rest.find((o) => o.label === 'crlf') as ViteLoadObservation;

    expect(lf.transformedStartsWithShebang).toBe(true);
    expect(lf.transformedHead.startsWith('#!/usr/bin/env node\n')).toBe(true);

    expect(crlf.transformedStartsWithShebang).toBe(false);
    expect(crlf.transformedHead.startsWith('__vite_ssr_exportName__(')).toBe(true);
    // ⬇ 这行就是病灶：导出注册落在 `#!` 之前，`#!` 不再位于文件起始
    expect(crlf.transformedHead.includes('#!/usr/bin/env node')).toBe(true);
    expect(crlf.transformedHead.indexOf('#!')).toBeGreaterThan(0);
    // 两份产物在"行尾以外"的一致性：CRLF 产物去掉多插入的注册行后应与 LF 同构
    expect(lf.transformedHead.replace(/\r\n/g, '\n')).toContain('exportName__("marker"');
  });
});

describe('③ 加载层 —— 真实 ssrLoadModule 求值：CRLF 抛 SyntaxError，LF 正常', () => {
  it('同内容同 shebang，只有行尾不同 ⇒ LF 加载成功、CRLF 抛 SyntaxError', () => {
    const lf = viteLoad.rest.find((o) => o.label === 'lf') as ViteLoadObservation;
    const crlf = viteLoad.rest.find((o) => o.label === 'crlf') as ViteLoadObservation;

    expect(lf.loaded, `LF 夹具应可加载：${lf.errorName ?? ''} ${lf.errorMessage ?? ''}`).toBe(true);
    expect(lf.marker).toBe('ok');
    expect(lf.errorName).toBeNull();

    expect(crlf.loaded).toBe(false);
    expect(crlf.errorName).toBe('SyntaxError');
    expect(crlf.errorMessage).not.toBeNull();
  });
});

describe('④ 复核层 —— vitest 自己的 mock 提升（@vitest/mocker）同一正则同一病灶', () => {
  it('mocker 的 hashbangRE 与 vite 原文一致（都是 /^#!.*\\n/）', () => {
    expect(mockerHoist).toHaveLength(2);
    for (const o of mockerHoist) {
      expect(o.regexSource).toBe('^#!.*\\n');
      expect(fs.existsSync(o.modulePath)).toBe(true);
      // 发行文件确实在 @vitest/mocker 里 —— 证明这条路径真的属于 vitest 的收集期
      expect(o.modulePath.replace(/\\/g, '/')).toContain('@vitest/mocker');
    }
  });

  it('含 vi.mock 的 CRLF shebang 文件，提升后 #! 不再在行首（收集期即炸）', () => {
    const lf = mockerHoist.find((o) => o.label === 'lf') as MockerHoistObservation;
    const crlf = mockerHoist.find((o) => o.label === 'crlf') as MockerHoistObservation;
    expect(lf.hoistedStartsWithShebang).toBe(true);
    expect(crlf.hoistedStartsWithShebang).toBe(false);
    // 提升进来的 vi.mock(...) 落在 #! 之前
    expect(crlf.hoistedHead.startsWith('vi.mock(')).toBe(true);
    expect(crlf.hoistedHead.indexOf('#!')).toBeGreaterThan(0);
  });
});
