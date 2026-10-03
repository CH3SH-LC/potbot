/**
 * APP-07「密钥不进 APK、网页或普通日志」（合同 R258）—— **源码级断言**。
 *
 * 手法沿用本仓库既有纪律（见 `tests/demo/demo-host-discipline.test.ts`）：
 *   ① 尺子先自证：把合成出来的"带密钥的假源码"喂给扫描器，**必须报警**；
 *      把干净样本喂进去，**必须放行**（否则扫描器是恒真空断言）；
 *   ② 再用同一把尺子扫真实仓库：`apps/android/app/src/main/**`（进 APK 的源码/清单/资源）
 *      与 `apps/demo/web/**`（进网页的页面源码）。
 *
 * ⚠️ 范围诚实声明：本判据只能证明**源码文本里没有密钥形态**。它**不能**证明
 * 真机运行时、构建产物（APK 字节）、或运行时内存里没有密钥——那些需要真机与构建，
 * 本批**没有设备、没有跑 Gradle**，一律标「未验证」。不得用本用例冒充真机证据。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, listFiles, readText, repoRelative } from '../support.js';

interface LeakRule { readonly label: string; readonly pattern: RegExp }

/**
 * 能**唯一命中**的密钥形态 —— 每条都要有足够长的 body，避免命中 `task-status` 这类标识串。
 * （教训记录在 `demo-host-discipline.test.ts`：早期用裸子串 `sk-` 会产生假阳性。）
 */
const LEAK_RULES: readonly LeakRule[] = [
  { label: '厂商密钥前缀', pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { label: '云安全访问密钥', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: '浏览器密钥', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: '代码平台令牌', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { label: '授权头令牌', pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/ },
  { label: 'PEM 私钥块', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY/ },
  { label: '赋值字面密钥', pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/i },
  { label: '环境变量泄漏', pattern: /process\.env\b/ },
  { label: '环境文件路径', pattern: /\.env\b/ },
  { label: 'provider 术语', pattern: /\bANTHROPIC\b|\bAUTH_TOKEN\b/ },
];

/** 扫描一批源文件，返回违规清单（空数组 = 干净）。**纯函数**，便于自证。 */
function scanForSecrets(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const rule of LEAK_RULES) {
      const hit = rule.pattern.exec(file.text);
      if (hit) violations.push(`${file.path} [${rule.label}] "${hit[0].slice(0, 32)}"`);
    }
  }
  return violations;
}

describe('扫描器的判别力（先证明尺子有刻度）', () => {
  it('抓得到「源码里写死厂商密钥」', () => {
    const found = scanForSecrets([
      { path: 'Fake.java', text: 'String k = "' + 'sk' + '-' + 'abcdefghijklmnop0123' + '";' },
    ]);
    expect(found.join('\n')).toContain('厂商密钥前缀');
  });

  it('抓得到「日志里拼进授权头」', () => {
    const found = scanForSecrets([
      { path: 'Fake.js', text: 'log("h=" + "' + 'Be' + 'arer' + ' ' + 'eyJhbGciOiJIUzI1In0.abcdefgh' + '");' },
    ]);
    expect(found.join('\n')).toContain('授权头令牌');
  });

  it('抓得到「赋值字面密钥」', () => {
    const found = scanForSecrets([
      { path: 'Fake.ts', text: 'const c = { api' + '_key: "' + '0123456789abcdef' + '" };' },
    ]);
    expect(found.join('\n')).toContain('赋值字面密钥');
  });

  it('干净样本零违规（对照臂，防止扫描器恒真）', () => {
    const found = scanForSecrets([
      { path: 'Clean.js', text: 'const el = document.getElementById("task-status");\nlog("已连接电脑服务");' },
    ]);
    expect(found).toEqual([]);
  });

  it('不会误伤既有标识串 task-status / task-stage', () => {
    expect(scanForSecrets([{ path: 'Clean.js', text: 'x("task-status"); y("task-stage");' }])).toEqual([]);
  });
});

describe('真实源码：进 APK 的安卓源码与进网页的页面源码都不含密钥形态', () => {
  function collect(dir: string): Array<{ path: string; text: string }> {
    return listFiles(dir)
      .filter((path) => /\.(java|kt|xml|gradle|properties|ts|js|mjs|html|css)$/.test(path))
      .map((path) => ({ path: repoRelative(path), text: readText(path) }));
  }

  const androidFiles = collect(join(REPO_ROOT, 'apps', 'android', 'app', 'src', 'main'));
  const webFiles = collect(join(REPO_ROOT, 'apps', 'demo', 'web'));

  it('安卓源码/清单/资源存在（否则本组判据无从成立）', () => {
    expect(androidFiles.length).toBeGreaterThan(0);
  });

  it('网页源码存在（否则本组判据无从成立）', () => {
    expect(webFiles.length).toBeGreaterThan(0);
  });

  it('进 APK 的源码/清单/资源未发现密钥形态', () => {
    const violations = scanForSecrets(androidFiles);
    expect(violations, `安卓侧发现密钥形态：\n${violations.join('\n')}`).toEqual([]);
  });

  it('进网页的页面源码未发现密钥形态', () => {
    const violations = scanForSecrets(webFiles);
    expect(violations, `网页侧发现密钥形态：\n${violations.join('\n')}`).toEqual([]);
  });

  it('本次新增的两个页面模块确实在扫描范围内（防止扫了个空集）', () => {
    const names = webFiles.map((f) => f.path);
    expect(names.some((n) => n.endsWith('asset-ops.js'))).toBe(true);
    expect(names.some((n) => n.endsWith('settings-model.js'))).toBe(true);
  });
});
