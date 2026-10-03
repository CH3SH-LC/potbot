/**
 * K-I23 验证 ②：桥不暴露任意文件 / 密钥 / 代码执行钩子。
 *
 * 判据：
 *   - 暴露给 JS 的方法名不命中危险名口径（read/write/file/exec/eval/key/... ）；
 *   - 桥源码不出现危险宿主调用（Runtime.exec / ProcessBuilder / File / loadUrl /
 *     evaluateJavascript / KeyStore / 反射 ...）；
 *   - submit 的门序是 origin → 运行中 → 执行器（fail-closed，先校验再执行）。
 *
 * 每条规则都配**反向对照**（合成的恶意 Java 片段必须被抓住）与**正向对照**
 * （干净片段必须不被误报），防止"正则写错 ⇒ 零命中 ⇒ 假绿灯"。
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_EXPOSED_NAME,
  FORBIDDEN_SINK_PATTERNS,
  JAVA_BRIDGE_PATH,
  findForbiddenExposedNames,
  findForbiddenSinks,
  parseExposedMethods,
  readSource,
} from './bridge-surface.js';

const JAVA_BRIDGE = readSource(JAVA_BRIDGE_PATH);
const EXPOSED = parseExposedMethods(JAVA_BRIDGE);

describe('K-I23 危险钩子：暴露名口径', () => {
  it('真实桥的 JS 面不命中任何危险方法名', () => {
    expect(findForbiddenExposedNames(EXPOSED)).toEqual([]);
    // 反向钉住：口径本身不是恒真空——一个文件读取入口必须被判危险。
    const evil = 'public final class X { @JavascriptInterface public String readFile(String path) { return ""; } }';
    const evilMethods = parseExposedMethods(evil);
    expect(evilMethods.map((m) => m.name)).toEqual(['readFile']);
    expect(findForbiddenExposedNames(evilMethods)).toEqual(['readFile']);
    // 正向对照：四个合法入口名一个都不该命中。
    for (const name of ['submit', 'subscribe', 'unsubscribe', 'cancel']) {
      expect(FORBIDDEN_EXPOSED_NAME.test(name), `${name} 被误判为危险名`).toBe(false);
    }
  });

  it('代码执行 / 密钥读取入口都会被判危险', () => {
    const cases = [
      'public String execScript(String code) { return null; }',
      'public String getApiKey() { return null; }',
      'public void openFile(String name) {}',
      'public String evalExpr(String src) { return null; }',
    ];
    for (const sig of cases) {
      const methods = parseExposedMethods(`@JavascriptInterface\n    ${sig}`);
      expect(methods.length, sig).toBe(1);
      expect(findForbiddenExposedNames(methods), sig).toHaveLength(1);
    }
  });
});

describe('K-I23 危险钩子：危险宿主调用口径', () => {
  it('真实桥源码不出现任何危险宿主调用', () => {
    expect(findForbiddenSinks(JAVA_BRIDGE)).toEqual([]);
  });

  it('反向对照：每条 sink 规则都能抓住对应的恶意片段', () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['runtime-exec', 'Runtime.getRuntime().exec("sh");'],
      ['process-builder', 'new ProcessBuilder("sh");'],
      ['java-io-file', 'new java.io.File("/etc/passwd");'],
      ['file-stream', 'new FileInputStream(p);'],
      ['file-object', 'new File(path);'],
      ['load-url', 'view.loadUrl(url);'],
      ['evaluate-javascript', 'webView.evaluateJavascript("1", null);'],
      ['add-js-interface', 'webView.addJavascriptInterface(obj, "n");'],
      ['keystore', 'KeyStore.getInstance("AndroidKeyStore");'],
      ['shared-prefs', 'getSharedPreferences("p", 0);'],
      ['reflection', 'Class.forName(name);'],
    ];
    for (const [id, snippet] of samples) {
      expect(findForbiddenSinks(snippet), id).toContain(id);
    }
    // 每条规则 id 都在样本里出现过（防规则被删/改名）。
    const ids = new Set(samples.map(([id]) => id));
    for (const rule of FORBIDDEN_SINK_PATTERNS) {
      expect(ids.has(rule.id), `规则 ${rule.id} 无反向对照样本`).toBe(true);
    }
  });

  it('正向对照：注释里的说明文字（含 evaluateJavascript）不误报', () => {
    const clean = [
      '// 把事件 JSON 经 WebView.evaluateJavascript 投给页面（此处只是说明，不调用）',
      '/* 不暴露任意文件、密钥、代码执行 */',
      'public String submit(String origin, String commandJson) { return commandJson; }',
    ].join('\n');
    expect(findForbiddenSinks(clean)).toEqual([]);
    // 但同样的调用一旦真在代码里出现，必须命中。
    expect(findForbiddenSinks('webView.evaluateJavascript("x", null);')).toEqual(['evaluate-javascript']);
  });
});

describe('K-I23 危险钩子：submit 的门序 fail-closed', () => {
  it('origin 校验先于运行状态、运行状态先于执行器判空', () => {
    const submit = EXPOSED.find((m) => m.name === 'submit');
    expect(submit, '找不到 submit').toBeDefined();
    const body = submit?.body ?? '';
    const originAt = body.search(/isAllowedOrigin\s*\(/);
    const runningAt = body.search(/!\s*running/);
    const dispatcherAt = body.search(/target\s*==\s*null/);
    expect(originAt).toBeGreaterThanOrEqual(0);
    expect(runningAt).toBeGreaterThan(originAt);
    expect(dispatcherAt).toBeGreaterThan(runningAt);
    // 缺执行器返回 EXECUTOR_UNAVAILABLE（绝不 succeeded）。
    expect(body).toContain('EXECUTOR_UNAVAILABLE');
    expect(body).not.toContain('"succeeded"');
  });
});
