/**
 * S6 验收用例 ②：**真伪实现的静态判别**（对应验收表「内核」一行）。
 *
 * 验收表明确写了"不足以通过的现象"：
 *   - 「HTTP 路由直接写 docx 并伪造事件」
 *   - 「点按钮得到仓库已有样例」（用 `tests/**` 的固定回答冒充模型）
 *
 * 这一组用例把上述两种假实现变成**可机判的源码判据**，并且自带**判别力自证**：
 * 扫描器对合成出来的"假实现"必须报警，对干净样本必须不报警。否则扫描器本身
 * 就是空断言（这正是项目在 V5 里自我曝露过的那类问题）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, listFiles, readText, repoRelative } from './support.js';

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface Violation {
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
}

/** 从 `tests/**` 或 `src/fake/**` 取固定回答 = 用仓库样例冒充模型产出。 */
const RULE_FIXTURE_IMPORT = 'import_from_tests_or_fake';
/** HTTP 层直接写磁盘 = 绕过内核 staged→宿主物化→published 链。 */
const RULE_HTTP_WRITES_DISK = 'http_layer_writes_to_disk';
/** HTTP 层直接调内核事件追加原语 = 具备伪造内核事件的入口。 */
const RULE_HTTP_FABRICATES_EVENTS = 'http_layer_appends_kernel_events';
/** 宿主不 import 内核 = 没有真正走调度链。 */
const RULE_HOST_MISSING_KERNEL = 'host_does_not_use_kernel';
/** 非测试的生产文件 import 假模型 = 用 mock 冒充真实模型产出（"mock 全绿"）。 */
const RULE_PROD_IMPORTS_FAKE_MODEL = 'production_imports_fake_model';

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const DISK_WRITE_RE =
  /\b(writeFileSync|writeFile|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync|copyFileSync)\s*\(/;

function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/**
 * 扫描宿主源码。`files` 是 `apps/demo/server/**` 下的 TS/JS 源文件。
 * 返回违规清单（空数组 = 未发现伪造形态）。
 */
export function scanHostSources(files: readonly SourceFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  if (files.length === 0) {
    return [
      {
        path: 'apps/demo/server',
        rule: RULE_HOST_MISSING_KERNEL,
        detail: 'apps/demo/server 下没有任何源文件：宿主尚未实现',
      },
    ];
  }

  let usesKernel = false;
  for (const file of files) {
    const name = repoRelative(file.path);
    const isHttpLayer = /(^|\/)http\.(ts|js|mjs)$/.test(name);
    const isTestFile = /\.test\.(ts|js|mjs)$/.test(name);
    const imported = importsOf(file.text);

    for (const spec of imported) {
      // 只有**生产文件**从 tests/** 或 src/fake/** 取固定回答才算伪造；测试文件里合法。
      if (!isTestFile && (/(^|\/)tests(\/|$)/.test(spec) || /src\/fake(\/|$)/.test(spec))) {
        violations.push({
          path: name,
          rule: RULE_FIXTURE_IMPORT,
          detail: `import 了 ${spec}（用仓库样例冒充真实产出）`,
        });
      }
      if (/src\/scheduler(\/|$)/.test(spec)) usesKernel = true;

      // 生产文件（非 *.test.ts）不得接假模型：验收表要求能区分"mock 全绿"与真实模型产出。
      if (!isTestFile && /fake-(server|model)|fakeModel/i.test(spec)) {
        violations.push({
          path: name,
          rule: RULE_PROD_IMPORTS_FAKE_MODEL,
          detail: `生产文件 import 了假模型 ${spec}：会用 mock 结果冒充真实模型产出`,
        });
      }
    }

    if (isHttpLayer) {
      if (DISK_WRITE_RE.test(file.text)) {
        violations.push({
          path: name,
          rule: RULE_HTTP_WRITES_DISK,
          detail: 'HTTP 层出现文件写入调用：产物必须由内核 staged→物化端口→published 链产生',
        });
      }
      for (const spec of imported) {
        if (/kernel-events/.test(spec)) {
          violations.push({
            path: name,
            rule: RULE_HTTP_FABRICATES_EVENTS,
            detail: `HTTP 层 import 了内核事件原语 ${spec}`,
          });
        }
      }
    }
  }

  if (!usesKernel) {
    violations.push({
      path: 'apps/demo/server',
      rule: RULE_HOST_MISSING_KERNEL,
      detail: '宿主没有任何文件 import src/scheduler：没有走内核调度链',
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 判别力自证：合成假实现必须被抓，干净实现必须放行
// ---------------------------------------------------------------------------

function writeTree(root: string, tree: Record<string, string>): SourceFile[] {
  const files: SourceFile[] = [];
  for (const [rel, text] of Object.entries(tree)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    files.push({ path: full, text });
  }
  return files;
}

describe('扫描器的判别力（先证明尺子有刻度）', () => {
  it('抓得到「HTTP 路由直接写 docx」', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-forge-a-'));
    try {
      const files = writeTree(root, {
        'http.ts': `import { writeFileSync } from 'node:fs';
import { createScheduler } from '../../../src/scheduler/index.js';
export function route(req) { writeFileSync('/tmp/a.docx', req.body); }
`,
      });
      const found = scanHostSources(files).map((v) => v.rule);
      expect(found).toContain(RULE_HTTP_WRITES_DISK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('抓得到「HTTP 层伪造内核事件」', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-forge-b-'));
    try {
      const files = writeTree(root, {
        'http.ts': `import { appendKernelEvent } from '../../../src/scheduler/kernel-events.js';
import { createScheduler } from '../../../src/scheduler/index.js';
export const r = () => appendKernelEvent({ kind: 'artifact_published' });
`,
      });
      const found = scanHostSources(files).map((v) => v.rule);
      expect(found).toContain(RULE_HTTP_FABRICATES_EVENTS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('抓得到「从 tests/** 取固定回答」', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-forge-c-'));
    try {
      const files = writeTree(root, {
        'jobs.ts': `import { canned } from '../../../tests/acceptance/office/office-support.js';
import { createScheduler } from '../../../src/scheduler/index.js';
export const j = () => canned();
`,
      });
      const found = scanHostSources(files).map((v) => v.rule);
      expect(found).toContain(RULE_FIXTURE_IMPORT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('抓得到「生产文件接了假模型（mock 全绿）」', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-forge-e-'));
    try {
      const files = writeTree(root, {
        'main.ts': `import { createFakeModel } from '../model/fake-server.js';
import { createScheduler } from '../../../src/scheduler/index.js';
export const m = () => createFakeModel();
`,
      });
      const found = scanHostSources(files).map((v) => v.rule);
      expect(found).toContain(RULE_PROD_IMPORTS_FAKE_MODEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('测试文件接假模型：不算违规（对照臂，避免误伤合法的 fixture 测试）', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-forge-f-'));
    try {
      const files = writeTree(root, {
        'kernel.test.ts': `import { createFakeModel } from '../model/fake-server.js';
import { createScheduler } from '../../../src/scheduler/index.js';
export const m = () => createFakeModel();
`,
      });
      expect(scanHostSources(files)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('抓得到「宿主完全没走内核」', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-forge-d-'));
    try {
      const files = writeTree(root, { 'jobs.ts': 'export const j = () => 42;\n' });
      const found = scanHostSources(files).map((v) => v.rule);
      expect(found).toContain(RULE_HOST_MISSING_KERNEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('干净实现：零违规（对照臂，防止扫描器恒真）', () => {
    const root = mkdtempSync(join(tmpdir(), 's6-clean-'));
    try {
      const files = writeTree(root, {
        'http.ts': `import { createServer } from 'node:http';
import { runJob } from './jobs.js';
export const r = () => runJob();
`,
        'jobs.ts': `import { createScheduler } from '../../../src/scheduler/index.js';
export const j = () => createScheduler;
`,
      });
      expect(scanHostSources(files)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('空文件集：报「宿主未实现」而不是静默通过', () => {
    const found = scanHostSources([]).map((v) => v.rule);
    expect(found).toEqual([RULE_HOST_MISSING_KERNEL]);
  });
});

// ---------------------------------------------------------------------------
// 对真实仓库应用扫描器
// ---------------------------------------------------------------------------

describe('真实宿主源码（apps/demo/server/**）', () => {
  const serverDir = join(REPO_ROOT, 'apps', 'demo', 'server');
  // 测试文件一并扫描：生产规则由扫描器按 `*.test.ts` 自行豁免（这样"豁免"本身也被对照臂覆盖）。
  const files: SourceFile[] = listFiles(serverDir)
    .filter((path) => /\.(ts|js|mjs)$/.test(path))
    .map((path) => ({ path, text: readText(path) }));

  it('宿主存在（否则本组验收条件不成立）', () => {
    expect(
      files.length,
      '[未满足] apps/demo/server 下没有实现源文件：S3 宿主尚未落地，本组判据无从成立',
    ).toBeGreaterThan(0);
  });

  it('未发现伪造形态：不走 tests/**、不经 HTTP 层写盘或伪造内核事件、确实 import 内核', () => {
    const violations = scanHostSources(files);
    const rendered = violations.map((v) => `${v.path} [${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] 宿主源码出现伪造形态：\n${rendered}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 页面不得泄漏密钥 / 实现术语（验收表「新输入驱动」与方案 §手机连通）
// ---------------------------------------------------------------------------

describe('手机页面（apps/demo/web/app.js）', () => {
  const appJs = join(REPO_ROOT, 'apps', 'demo', 'web', 'app.js');

  /**
   * 密钥/术语形态（**必须是能唯一命中的形态**）。
   * 第一版写成子串 `'sk-'`，被 `task-status` / `task-stage` 命中，是**假阳性**——
   * 已改为带边界的形态：密钥必须有足够长的 body，术语按整词匹配。
   */
  const LEAK_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: 'api-key-shape', pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
    { label: 'AUTH_TOKEN', pattern: /\bAUTH_TOKEN\b/ },
    { label: 'ANTHROPIC', pattern: /\bANTHROPIC\b/ },
    { label: 'Bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/ },
    { label: 'apiKey', pattern: /\bapi[_-]?key\b/i },
    { label: 'env-var-leak', pattern: /process\.env\b/ },
    { label: '.env path', pattern: /\.env\b/ },
  ];

  it('页面存在且不含密钥或 provider 术语', () => {
    const files = listFiles(join(REPO_ROOT, 'apps', 'demo', 'web'));
    expect(
      files.length,
      '[未满足] apps/demo/web 下没有页面资源：S2 页面尚未落地，本组判据无从成立',
    ).toBeGreaterThan(0);

    const leaked: string[] = [];
    for (const path of files) {
      if (!/\.(js|mjs|html|css)$/.test(path)) continue;
      const text = readText(path);
      for (const { label, pattern } of LEAK_PATTERNS) {
        const hit = pattern.exec(text);
        if (hit) leaked.push(`${repoRelative(path)} 命中 ${label}（"${hit[0].slice(0, 40)}"）`);
      }
    }
    expect(leaked, `[未通过] 页面泄漏密钥/术语：${leaked.join('; ')}`).toEqual([]);
  });
});
