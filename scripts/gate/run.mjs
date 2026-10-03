#!/usr/bin/env node
/**
 * FA-BOUND-RUN-LEDGER —— **绑候选的门禁运行器**
 *
 * ## 它解决什么问题（外部监督 13:40 第 3 组第 4 / 5 条）
 *
 * 监督原文：
 *   4. 「记录每次验证的 HEAD、dirty 范围、命令、时间、退出码、原始日志和文件摘要。
 *       失败日志单独保留，不原地覆盖。」
 *   5. 「修后只跑一次绑候选的完整门禁。」
 *
 * 本项目此前的两次事故正是这两条的缺失造成的：
 *   - **FA-X**：门禁日志**按文件名原地覆盖**（`... > selfcheck-final.txt`），监督 10:26 引用的
 *     `827 pass + 1 fail / EXIT=1` 快照被 10:37 的 `828 pass / EXIT=0` 覆盖，**不可恢复**，
 *     且该文件**不记 HEAD**，无法证明它跑在哪个候选上。
 *   - **FA-Q**：曾把两条**不同命令、不同时刻**运行的数字（827 vs 828）并排比较——它们是
 *     **不可比**的（见 `tests/full-app/run-ledger.ts` 的 `mayCompare`）。
 *
 * ## 本运行器给出一份**不可覆盖、绑候选**的工件
 *
 * 对**每一次**运行，在 `<out>/<时间戳>-<短HEAD>/` 落一份**新目录**（目录已存在即报错，
 * 绝不覆盖），内含：
 *
 *   - `summary.txt` —— 按序的人读记录：HEAD（完整 sha）、`git status --porcelain` 的
 *     **行数与逐条摘要**、**命令（逐字）**、开始/结束时间、**退出码**、源码摘要；
 *   - `stdout.txt` / `stderr.txt` —— **原始字节**、分别完整落盘（不截断、不 `| tail`）；
 *   - `meta.json` —— 同一批数据的机器可读形式（供 `mayCompare` 之类的守卫消费）。
 *
 * **失败日志单独保留**：退出码非 0 时，**额外**把上面整份工件**复制**到
 * `<out>/failures/<时间戳>-<短HEAD>/`。复制前先查目标是否存在，存在即报错——
 * 即"失败日志不会被任何一次后续运行覆盖"。FA-X 那种原地覆盖在这里是**结构性不可能**。
 *
 * ## 全量源码摘要
 *
 * 复用 `tests/acceptance/source-digest.ts` 的**行编码口径**（`${fileSha256} *${posixPath}\n`，
 * 路径按 UTF-8 字节序排序，整体 = sha256(拼接)），域扩为 `src/` + `apps/` + `tests/` 下的
 * `.ts` / `.js` / `.json`（本运行器需要的域比验收器宽；口径本身逐字相同）。
 * 摘要在**命令执行前**与**执行后**各算一次：二者不一致即说明本次运行**自身改动了被测源码**，
 * 记为 `DIGEST_DRIFT: true`（这本身就是值得留存的证据）。
 *
 * ## 不可比守卫
 *
 * 导出 `mayCompare(a, b)` / `compareVerdict(a, b)` / `assertComparable(a, b)`：
 * **只有 HEAD 完整相同（且都已记录）、命令逐字相同、dirty 范围相同、环境前置相同时**
 * 才允许比较两次运行的数字；否则拒绝并给出**原因**（后两项见 R-2）。这是"827 vs 828"教训的机器化形式。
 *
 * ## FA-GATE-RUNNER-FIX 的四条（首份绑候选报告暴露）
 *
 * ### R-1 前置 `pnpm demo:build`：四条命令自足 + "缺前置"不记成测试失败
 *
 * `DEFAULT_COMMANDS` **仍只列四条被请求的**门禁命令（保持既有断言与语义不变），
 * 但 `pnpm test`（基座 `vitest.config.ts` 的 include 是 `tests/**\/*.test.ts`，它**包含**
 * `tests/demo/**\/*.test.ts`）与 `pnpm demo:test` 都依赖 `pnpm demo:build`
 * （`tsc -p tsconfig.demo.json`）产出的 `.runtime/mobile-word-demo/build/apps/demo/server/main.js`。
 * 未构建就跑 ⇒ 这两条报出成片的"模块不存在"，被**误记成测试失败**。
 *
 *   - **默认**：`resolveGatePlan` 把 `pnpm demo:build` 作为这两条的**前置**注入到它们**之前**
 *     （去重；顺序依赖登记见 `COMMAND_PREREQUISITES` 与 `PREREQUISITE_ORDER_NOTE`）——
 *     默认四条因此**自足**，全新工作树上首轮不再因缺编译而红。
 *   - **`--no-prereq`**：不注入；若某条命令的前置**未满足**（存在性探针 `probePrerequisite`），
 *     该条**不执行**，落一份 `outcome: skipped_missing_prerequisite` 的记录并给出结构化提示
 *     （`MISSING_PREREQUISITE` / `HINT`），`exitCode` 记 `null`（**没有**跑过命令），
 *     运行器退出码为 `EXIT_MISSING_PREREQUISITE`——**绝不**把它记成一次测试失败
 *     （不生成 `failures/` 副本，日志里也不会出现成片的模块解析错误）。
 *
 * ### R-2 可比键纳入 dirty 范围与环境前置
 *
 * `compareVerdict` 除 HEAD 与命令外**再比**两项：dirty 范围（脏条目逐条签名）与
 * **环境前置**（如 `demo:build` 是否跑过 / 是否满足）。任一被记录即参与比较，不同即拒绝并说明原因；
 * 两侧都没这些字段的精简记录保持既有语义（HEAD＋命令）不变。
 *
 * ### R-3 摘要域与 `.task-manifest/` 的口径登记
 *
 * **不扩展** `DIGEST_SCOPE_DIRS`（仍是 src+apps+tests 的 .ts/.js/.json，与 source-digest 逐字同口径）。
 * 理由：`.task-manifest/` 下是大量**未跟踪**的过程证据（见 `.task-manifest/outputs/**`），
 * 纳入摘要会让"源码摘要"随证据文件增删漂移、失去"绑被测源码"的意义。
 * 取而代之：每次运行把 `git status --porcelain` 的路径**按摘要域分类**，把域外的脏条目
 * （如 `.task-manifest/**` 的自改写）单独记进 `outOfScopeDirty`（summary + meta 都写）——
 * 盲区因此**可见、可归因**，而不是被静默漏掉。口径选择逐字登记在 `DIGEST_SCOPE_DECISION`。
 *
 * ### R-4 逐命令采 dirty
 *
 * 每条命令**前后各采一次** `git status --porcelain`，落 `dirtyBefore` / `dirtyAfter` /
 * `dirtyDelta`（新增 / 消失的脏条目）——"哪条命令写脏了什么"可逐条归因，
 * 而不是整轮首尾各一次（此前 0→8→18 的递增无法定位到具体命令）。
 *
 * ## 用法
 *
 *     scripts\gate\run.cmd                                  # 默认四条 + 自动注入前置 pnpm demo:build
 *     node scripts/gate/run.mjs --cmd "npx --no-install tsc --noEmit"
 *     node scripts/gate/run.mjs --list                      # 打印默认计划（含注入的前置与顺序登记）
 *     node scripts/gate/run.mjs --out .dev-evidence/gate    # 换工件根（默认即此）
 *     node scripts/gate/run.mjs --stamp 20261003T141230123  # 固定时间戳分量（复现 / 测试用）
 *     node scripts/gate/run.mjs --no-prereq --cmd "pnpm demo:test"   # 不注入；缺前置 ⇒ 结构化提示
 *     node scripts/gate/run.mjs --repo-root <目录>          # 对另一份检出跑（缺省=本工作树；测试用）
 *
 * 退出码：单条命令时**透传该命令的退出码**；多条时取**首个非 0**，全 0 则 0；
 * 某条因**缺前置**被跳过（`--no-prereq`）时记 `EXIT_MISSING_PREREQUISITE`（78，**不是**测试失败）；
 * 运行器**自身**出错（参数错误、工件已存在等）固定 1，并在 stderr 打 `gate_runner_error:`。
 *
 * 说明：本包为子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根：`scripts/gate/run.mjs` 上溯两级。在 worktree 里即 worktree 根。 */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** 默认工件根（`.dev-evidence/` 已 gitignore —— 门禁证据不入库）。 */
export const DEFAULT_OUT_DIR = join(REPO_ROOT, '.dev-evidence', 'gate');

/** 默认门禁命令（外部监督第 5 条：「修后只跑一次绑候选的完整门禁」的四条）。 */
export const DEFAULT_COMMANDS = Object.freeze([
  'pnpm typecheck',
  'pnpm demo:typecheck',
  'pnpm test',
  'pnpm demo:test',
]);

/** 源码摘要域（相对仓库根）。 */
export const DIGEST_SCOPE_DIRS = Object.freeze(['src', 'apps', 'tests']);
/** 源码摘要收录的扩展名。 */
export const DIGEST_EXTENSIONS = Object.freeze(['.ts', '.js', '.json']);
/** 源码摘要**排除**的目录名（构建产物 / 依赖，会随构建漂移，不属于被测源码）。 */
export const DIGEST_EXCLUDED_DIRS = Object.freeze([
  'node_modules',
  'build',
  'dist',
  '.gradle',
  '__pycache__',
  '.git',
]);
/** 摘要口径人读原文（逐字写进工件，便于独立复算）。 */
export const DIGEST_ALGORITHM_NOTE =
  'line = `${sha256hex(file bytes)} *${posix-rel-path}\\n`; scope = src+apps+tests, ' +
  'name ends with .ts/.js/.json, directory entries excluded, dirs named ' +
  'node_modules|build|dist|.gradle|__pycache__|.git pruned; sorted by UTF-8 byte order (LC_ALL=C); ' +
  'lines concatenated as UTF-8 (LF, no BOM); overall = sha256(concat). '
  + '编码口径与 tests/acceptance/source-digest.ts 逐字相同（该文件域为 src+tests 的 *.ts）。';

/** 每次运行落盘的固定文件清单（失败复制按此清单整份搬运）。 */
export const ARTIFACT_FILES = Object.freeze(['summary.txt', 'stdout.txt', 'stderr.txt', 'meta.json']);

/** HEAD 未记录时的显式占位符（与 `tests/full-app/run-ledger.ts` 同一约定）。 */
export const HEAD_UNRECORDED = 'NOT_RECORDED';

/** demo 宿主的构建命令（`tsc -p tsconfig.demo.json`）。 */
export const DEMO_BUILD_COMMAND = 'pnpm demo:build';

/** 构建产物的存在性探针目标：demo 宿主入口（`tests/demo/**` 与 apps/demo 用例真正 require 的东西）。 */
export const DEMO_HOST_MAIN_REL = '.runtime/mobile-word-demo/build/apps/demo/server/main.js';

/**
 * **顺序依赖登记**（R-1）：哪条门禁命令需要哪条前置。
 *
 * 为什么基座 `pnpm test` 也依赖 demo 构建：`vitest.config.ts` 的 include 是
 * `['src/**\/*.test.ts', 'tests/**\/*.test.ts']`，**包含** `tests/demo/**\/*.test.ts`；
 * 那些用例 require 编译后的 `.runtime/mobile-word-demo/build/apps/demo/server/main.js`。
 * 未构建 ⇒ 它们报"模块不存在"，看起来像测试失败，实为缺前置。
 *
 * `pnpm typecheck` / `pnpm demo:typecheck` 是 `--noEmit` 类型检查，**不**读构建产物，故不登记前置。
 */
export const COMMAND_PREREQUISITES = Object.freeze({
  'pnpm test': Object.freeze([DEMO_BUILD_COMMAND]),
  'pnpm demo:test': Object.freeze([DEMO_BUILD_COMMAND]),
});

/** 顺序依赖的人读登记（逐字写进 `--list` 与工件，便于独立复核）。 */
export const PREREQUISITE_ORDER_NOTE =
  'pnpm demo:build 是 pnpm test 与 pnpm demo:test 的前置：基座 vitest 配置的 include '
  + 'tests/**/*.test.ts 包含 tests/demo/**，而 tests/demo 用例 require 编译后的宿主入口 '
  + `${DEMO_HOST_MAIN_REL}（由 pnpm demo:build = tsc -p tsconfig.demo.json 产出）。`;

/** 因**缺前置**而跳过时运行器给出的退出码（78；**不是**测试失败，与 1=运行器自身错误区分）。 */
export const EXIT_MISSING_PREREQUISITE = 78;

/**
 * 摘要域口径的**已登记**选择（R-3）：保持 src+apps+tests 不变，**不**纳入 `.task-manifest/`。
 *
 * 替代方案（纳入 `.task-manifest/` 后靠 `outOfScopeDirty` 之外再算一份全树摘要）被否：
 * 该目录以**未跟踪**证据文件为主（`.task-manifest/outputs/**` 每轮新增），
 * 纳入会让摘要随证据增删漂移、不再"绑被测源码"。域外的脏条目改由
 * `classifyDirtyPaths` / 每次运行的 `outOfScopeDirty` 如实报出。
 */
export const DIGEST_SCOPE_DECISION = Object.freeze({
  included: Object.freeze([...DIGEST_SCOPE_DIRS]),
  extensionFilter: Object.freeze([...DIGEST_EXTENSIONS]),
  registeredExclusions: Object.freeze(['.task-manifest', 'docs', 'scripts', '.runtime']),
  outOfScopeSignal: 'outOfScopeDirty（每次运行的 git status 脏条目按摘要域分类后，域外部分单独列出）',
  rationale:
    '不扩展摘要域：.task-manifest/ 以未跟踪的过程证据为主，纳入会让"源码摘要"随证据增删漂移，'
    + '失去绑被测源码的意义；域外的自改写改由 outOfScopeDirty 如实报出（可见、可归因，而非静默漏掉）。',
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** sha256（小写十六进制）。 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** UTF-8 字节序比较（等价于 `LC_ALL=C sort`，与 source-digest 口径一致）。 */
export function compareByByteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 短 HEAD（前 7 位）；未记录时原样返回占位符。 */
export function shortHead(head) {
  if (typeof head !== 'string') return HEAD_UNRECORDED;
  const trimmed = head.trim();
  if (trimmed.length === 0) return HEAD_UNRECORDED;
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed;
}

/** 时间戳分量：`YYYYMMDDTHHMMSSmmm`（本地时区，含毫秒以防同秒两次运行撞名）。 */
export function formatStamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `T${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`
  );
}

/** 带本地时区偏移的 ISO 时间（与 run-ledger 的 `at` 同形：`2026-10-03T05:19:27+0800`）。 */
export function formatIsoLocal(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`
  );
}

// ---------------------------------------------------------------------------
// 不可覆盖写入
// ---------------------------------------------------------------------------

/** 构造"拒绝覆盖既有工件"的错误（带稳定 code，供测试与调用方判别）。 */
export function artifactExistsError(target) {
  const error = new Error(`artifact_exists: 拒绝覆盖既有工件 ${target}`);
  error.code = 'artifact_exists';
  error.target = target;
  return error;
}

/**
 * **不可覆盖写入**：目标已存在则抛 `artifact_exists`，绝不覆盖。
 *
 * 用 `flag: 'wx'`（独占创建）而非"先 existsSync 再写"——后者在并发下仍有竞态窗口；
 * `wx` 由内核保证"文件已存在即失败"，这才是"绝不覆盖"的真正语义。
 */
export async function writeNoClobber(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, data, { flag: 'wx' });
  } catch (error) {
    if (error && error.code === 'EEXIST') throw artifactExistsError(filePath);
    throw error;
  }
  return filePath;
}

/** 创建一份**新**目录；已存在即抛 `artifact_exists`。 */
export async function mkdirNoClobber(dirPath) {
  if (existsSync(dirPath)) throw artifactExistsError(dirPath);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

/** 把一份工件目录整份复制到新目录（逐文件走 writeNoClobber；目标已存在即报错）。 */
export async function copyArtifactDirNoClobber(srcDir, destDir) {
  if (existsSync(destDir)) throw artifactExistsError(destDir);
  await mkdir(destDir, { recursive: true });
  for (const name of ARTIFACT_FILES) {
    const src = join(srcDir, name);
    if (!existsSync(src)) continue;
    await writeNoClobber(join(destDir, name), await readFile(src));
  }
  return destDir;
}

// ---------------------------------------------------------------------------
// 源码摘要
// ---------------------------------------------------------------------------

/** 递归列出摘要域内的相对路径（POSIX 正斜杠），按 UTF-8 字节序排序。 */
export function listDigestFiles(root) {
  const out = [];
  const walk = (absoluteDir) => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 不可读 ⇒ 该子树为空
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DIGEST_EXCLUDED_DIRS.includes(entry.name)) continue;
        walk(join(absoluteDir, entry.name));
        continue;
      }
      if (!DIGEST_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      out.push(relative(root, join(absoluteDir, entry.name)).split(sep).join('/'));
    }
  };
  for (const dir of DIGEST_SCOPE_DIRS) walk(join(root, dir));
  out.sort(compareByByteOrder);
  return out;
}

/** 计算 `src`+`apps`+`tests` 的 `.ts/.js/.json` 摘要（与 source-digest 同口径）。 */
export function computeSourceDigest(root) {
  const paths = listDigestFiles(root);
  const lines = [];
  for (const path of paths) {
    let bytes;
    try {
      bytes = readFileSync(join(root, ...path.split('/')));
    } catch {
      continue; // 读不到的条目（如指向目录的符号链接）不参与摘要
    }
    lines.push(`${sha256Hex(bytes)} *${path}\n`);
  }
  return Object.freeze({
    scope: Object.freeze([...DIGEST_SCOPE_DIRS]),
    extensions: Object.freeze([...DIGEST_EXTENSIONS]),
    excludedDirs: Object.freeze([...DIGEST_EXCLUDED_DIRS]),
    // R-3：域外顶层目录的**已登记**选择（.task-manifest/ 等在域外；理由见 DIGEST_SCOPE_DECISION）。
    registeredExclusions: Object.freeze([...DIGEST_SCOPE_DECISION.registeredExclusions]),
    fileCount: lines.length,
    sha256: sha256Hex(Buffer.from(lines.join(''), 'utf8')),
    algorithm: DIGEST_ALGORITHM_NOTE,
  });
}

// ---------------------------------------------------------------------------
// git 身份
// ---------------------------------------------------------------------------

function gitRaw(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim() || String(result.error?.message ?? ''),
  };
}

/**
 * 采集候选身份：HEAD 完整 sha、分支、`git status --porcelain` 的行数与逐条摘要。
 *
 * **不对 porcelain 做 trim**：porcelain 每行形如 `XY path`，`X` 可能是空格（如 ` M x.ts`），
 * 整体 trim 会吃掉**首行**前导空格，把身份记录写歪。
 */
export function collectCandidate(root) {
  const headResult = gitRaw(root, ['rev-parse', 'HEAD']);
  const branchResult = gitRaw(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusResult = gitRaw(root, ['status', '--porcelain']);
  const head = headResult.ok ? headResult.stdout.trim() : HEAD_UNRECORDED;
  const branch = branchResult.ok ? branchResult.stdout.trim() : HEAD_UNRECORDED;
  const status = summarizePorcelain(statusResult.ok ? statusResult.stdout : '');
  return {
    head,
    headShort: shortHead(head),
    branch,
    headError: headResult.ok ? null : headResult.stderr,
    statusOk: statusResult.ok,
    statusError: statusResult.ok ? null : statusResult.stderr,
    status,
  };
}

/** `git status --porcelain` 的行数与逐条摘要（逐行原样 + 按 XY 码计数）。 */
export function summarizePorcelain(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const byCode = {};
  for (const line of lines) {
    const code = line.slice(0, 2);
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  return Object.freeze({ count: lines.length, lines: Object.freeze(lines), byCode: Object.freeze(byCode) });
}

/**
 * 由一份 porcelain 摘要补上**逐条签名**，构成一次 dirty 采样（R-4 / R-2）。
 *
 * 签名 = `sha256(lines.join('\n'))`：逐条参与比较时，只要脏条目不同（哪怕行数相同）签名即不同。
 */
export function dirtyFromSummary(summary, statusOk = true, statusError = null) {
  return Object.freeze({
    count: summary.count,
    byCode: summary.byCode,
    lines: summary.lines,
    signature: sha256Hex(Buffer.from(summary.lines.join('\n'), 'utf8')),
    statusOk,
    statusError,
  });
}

/** 采一次 dirty（R-4）：现采 `git status --porcelain` 并附签名。 */
export function collectDirty(root) {
  const statusResult = gitRaw(root, ['status', '--porcelain']);
  const summarized = summarizePorcelain(statusResult.ok ? statusResult.stdout : '');
  return dirtyFromSummary(summarized, statusResult.ok, statusResult.ok ? null : statusResult.stderr);
}

/** 从一条 `git status --porcelain` 行里取出路径（处理 `R  old -> new` 与引号）。 */
export function porcelainPath(line) {
  let rest = String(line ?? '').slice(2).trim();
  const arrow = rest.lastIndexOf(' -> ');
  if (arrow >= 0) rest = rest.slice(arrow + 4);
  rest = rest.trim();
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest.trim();
}

/** 相对路径是否落在**摘要域**内（scope 目录 + 扩展名 + 排除目录）。 */
export function isInDigestScope(relPath) {
  const posix = String(relPath ?? '').split('\\').join('/');
  if (posix.length === 0) return false;
  if (!DIGEST_SCOPE_DIRS.some((dir) => posix === dir || posix.startsWith(`${dir}/`))) return false;
  const parts = posix.split('/');
  const dirParts = parts.slice(1, -1);
  if (dirParts.some((p) => DIGEST_EXCLUDED_DIRS.includes(p))) return false;
  return DIGEST_EXTENSIONS.some((ext) => posix.endsWith(ext));
}

/**
 * 把脏条目**按摘要域分类**（R-3）：域外条目（如 `.task-manifest/**` 的自改写）单独列出——
 * 这些正是"摘要域不含 .task-manifest ⇒ 漏报套件对 tracked 工件的自改写"的**可见化**。
 */
export function classifyDirtyPaths(lines) {
  const inDigestScope = [];
  const outOfDigestScope = [];
  for (const line of lines ?? []) {
    const path = porcelainPath(line);
    if (path.length === 0) continue;
    (isInDigestScope(path) ? inDigestScope : outOfDigestScope).push(path);
  }
  return Object.freeze({
    inDigestScope: Object.freeze(inDigestScope),
    outOfDigestScope: Object.freeze(outOfDigestScope),
  });
}

/** 两次 dirty 采样之差（R-4）：哪条命令新写了什么 / 清掉了什么，可逐条归因。 */
export function diffDirty(before, after) {
  const beforeSet = new Set(before?.lines ?? []);
  const afterSet = new Set(after?.lines ?? []);
  const added = (after?.lines ?? []).filter((line) => !beforeSet.has(line));
  const removed = (before?.lines ?? []).filter((line) => !afterSet.has(line));
  return Object.freeze({
    countBefore: before?.count ?? 0,
    countAfter: after?.count ?? 0,
    delta: (after?.count ?? 0) - (before?.count ?? 0),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
  });
}

/** 前置命令的存在性探针（R-1）：未登记探针的前置保守判"未满足"（宁可提示先构建，也不静默当成功）。 */
export function probePrerequisite(root, command) {
  if (command === DEMO_BUILD_COMMAND) {
    const target = join(resolve(root), ...DEMO_HOST_MAIN_REL.split('/'));
    const satisfied = existsSync(target);
    return Object.freeze({
      command,
      satisfied,
      probe: `file_exists:${DEMO_HOST_MAIN_REL}`,
      detail: satisfied
        ? `构建产物存在：${DEMO_HOST_MAIN_REL}`
        : `构建产物缺失：${DEMO_HOST_MAIN_REL}`,
    });
  }
  return Object.freeze({
    command,
    satisfied: false,
    probe: 'unregistered',
    detail: `未登记存在性探针的前置命令：${command}`,
  });
}

/** 一条命令的**前置状态**清单（供记录的环境前置键与 summary 使用）。 */
export function collectPrerequisiteStates(root, command, graph = COMMAND_PREREQUISITES, executed = new Set()) {
  const required = graph?.[command] ?? [];
  return Object.freeze(required.map((prereq) => {
    const probe = probePrerequisite(root, prereq);
    return Object.freeze({
      command: prereq,
      executed: executed.has(prereq),
      satisfied: probe.satisfied,
      probe: probe.probe,
      detail: probe.detail,
    });
  }));
}

/** 环境前置的**可比较键**（R-2）：`<命令>:executed|present|missing`，无前置则 `none`。 */
export function prerequisiteKeyOf(states) {
  if (!Array.isArray(states) || states.length === 0) return 'none';
  return states
    .map((s) => `${s.command}:${s.executed ? 'executed' : (s.satisfied ? 'present' : 'missing')}`)
    .join('|');
}

/**
 * 一条**被请求**命令的"缺前置"判定（R-1，纯函数，供 `--no-prereq` 模式与测试用）：
 * 返回 `null`（前置都满足，应照常执行）或 `{ reason, missing, hint }`（应结构化跳过）。
 *
 * 只在**不注入**前置时使用——注入模式下前置会被跑掉，不存在"缺"。
 */
export function prerequisiteSkipFor(root, command, graph = COMMAND_PREREQUISITES) {
  const missing = (graph?.[command] ?? []).filter((prereq) => !probePrerequisite(root, prereq).satisfied);
  if (missing.length === 0) return null;
  return Object.freeze({
    reason: 'missing_prerequisite',
    missing: Object.freeze([...missing]),
    hint: `请先运行 ${missing.map((m) => `\`${m}\``).join(' 或 ')}；`
      + '或去掉 --no-prereq，让运行器自动注入前置。',
  });
}

/**
 * 把被请求的命令展开成**有序执行计划**（R-1）。
 *
 * - `injectPrerequisites !== false`（默认）：每条命令的登记前置被插到它**之前**，同一条前置只注入一次；
 * - `injectPrerequisites === false`（`--no-prereq`）：只保留被请求的命令（缺前置由 `runGate` 判 skip）。
 *
 * 步骤形如 `{ command, kind: 'prerequisite'|'requested', forCommand, requiredBy }`。
 */
export function resolveGatePlan(commands, options = {}) {
  const list = commands?.length ? [...commands] : [...DEFAULT_COMMANDS];
  const inject = options.injectPrerequisites !== false;
  const graph = options.prerequisites ?? COMMAND_PREREQUISITES;
  const steps = [];
  const injected = new Map();
  for (const command of list) {
    const required = graph[command] ?? [];
    if (inject) {
      for (const prereq of required) {
        const existing = injected.get(prereq);
        if (existing) {
          existing.requiredBy.push(command);
          continue;
        }
        const step = { command: prereq, kind: 'prerequisite', forCommand: command, requiredBy: [command] };
        injected.set(prereq, step);
        steps.push(step);
      }
    }
    steps.push({ command, kind: 'requested', forCommand: null, requiredBy: [...required] });
  }
  return steps.map((step) => Object.freeze({
    command: step.command,
    kind: step.kind,
    forCommand: step.forCommand,
    requiredBy: Object.freeze([...step.requiredBy]),
  }));
}

// ---------------------------------------------------------------------------
// 不可比守卫（"827 vs 828"的教训）
// ---------------------------------------------------------------------------

/** HEAD 是否被真实记录（占位符 / 空串一律算"未记录"）。 */
export function isRecordedHead(head) {
  if (typeof head !== 'string') return false;
  const value = head.trim();
  if (value.length === 0) return false;
  const upper = value.toUpperCase();
  return upper !== HEAD_UNRECORDED && upper !== 'UNKNOWN';
}

/** 摘要一个比较键里的长串（签名 / 大文件清单），避免原因里刷屏。 */
function brief(value) {
  if (value === undefined) return '(未记录)';
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 16)}…(${text.length}B)` : text;
}

/** 取一条运行记录的 **dirty 范围键**（R-2）：显式 `dirtySignature`，或 `dirty` 里的签名 / 逐条。 */
function dirtyKeyOf(run) {
  if (!run || typeof run !== 'object') return undefined;
  if (typeof run.dirtySignature === 'string') return run.dirtySignature;
  const dirty = run.dirty;
  if (dirty && typeof dirty === 'object') {
    if (typeof dirty.signature === 'string') return dirty.signature;
    if (Array.isArray(dirty.lines)) return dirty.lines.join('\n');
    if (typeof dirty.count === 'number') return `count:${dirty.count}`;
  }
  return undefined;
}

/** 取一条运行记录的 **环境前置键**（R-2）：显式 `prerequisiteKey`，或 `prerequisites` 逐条。 */
function prerequisiteKeyOfRun(run) {
  if (!run || typeof run !== 'object') return undefined;
  if (typeof run.prerequisiteKey === 'string') return run.prerequisiteKey;
  if (Array.isArray(run.prerequisites)) return prerequisiteKeyOf(run.prerequisites);
  return undefined;
}

/**
 * 判断两条运行记录的数字**是否可比**，并**说明原因**。
 *
 * 判据（外部监督口径 + FA-GATE-RUNNER-FIX R-2）：**HEAD 完整相同且已记录** 且 **命令逐字相同**，
 * 且 **dirty 范围相同** 且 **环境前置相同**（如 `demo:build` 是否跑过 / 是否满足）。
 * 缺一即拒绝——不同候选、不同命令、不同脏区、不同前置的数字**不得**并排比较。
 *
 * 兼容：只写了 `{ head, command }` 的精简记录（两侧都没 dirty / 前置字段）保持既有语义，
 * 不会被新增的两项误伤；任一侧**被记录**时该项即参与比较，不一致就拒绝。
 */
export function compareVerdict(a, b) {
  const reasons = [];
  if (!a || !b) {
    return { ok: false, reasons: ['一次或两次运行记录缺失（null/undefined），没有可比对象'] };
  }
  if (!isRecordedHead(a.head) || !isRecordedHead(b.head)) {
    reasons.push(
      `HEAD 未记录（a=${String(a.head)}, b=${String(b.head)}）：未绑候选的运行一律不可比`,
    );
  } else if (a.head !== b.head) {
    reasons.push(`HEAD 不同（a=${shortHead(a.head)} vs b=${shortHead(b.head)}）：跨候选的数字不可比`);
  }
  if (a.command !== b.command) {
    reasons.push(`命令不同（a=${JSON.stringify(a.command)} vs b=${JSON.stringify(b.command)}）：不同命令的数字不可比`);
  }
  const dirtyA = dirtyKeyOf(a);
  const dirtyB = dirtyKeyOf(b);
  if ((dirtyA !== undefined || dirtyB !== undefined) && dirtyA !== dirtyB) {
    reasons.push(
      `dirty 范围不同（a=${brief(dirtyA)} vs b=${brief(dirtyB)}）：工作树脏区不同的数字不可比`,
    );
  }
  const prereqA = prerequisiteKeyOfRun(a);
  const prereqB = prerequisiteKeyOfRun(b);
  if ((prereqA !== undefined || prereqB !== undefined) && prereqA !== prereqB) {
    reasons.push(
      `环境前置不同（a=${brief(prereqA)} vs b=${brief(prereqB)}）：前置（如 ${DEMO_BUILD_COMMAND} 是否跑过）不同的数字不可比`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/** 布尔形式：只有 HEAD 相同（且都记录）＋命令逐字相同＋ dirty 范围与环境前置相同（若被记录）时为 true。 */
export function mayCompare(a, b) {
  return compareVerdict(a, b).ok;
}

/** 断言形式：不可比即抛 `incomparable_runs`，错误带上逐条原因。 */
export function assertComparable(a, b) {
  const verdict = compareVerdict(a, b);
  if (!verdict.ok) {
    const error = new Error(`incomparable_runs: ${verdict.reasons.join('；')}`);
    error.code = 'incomparable_runs';
    error.reasons = verdict.reasons;
    throw error;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 运行一次
// ---------------------------------------------------------------------------

/** 执行一条命令，**完整**收集 stdout / stderr 原始字节。 */
function spawnCapture(command, cwd) {
  return new Promise((resolvePromise) => {
    const startedAt = new Date();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env } });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      stderrChunks.push(Buffer.from(String(error.message), 'utf8'));
      resolvePromise({
        exitCode: 127,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        startedAt,
        endedAt: new Date(),
        spawnError: String(error.message),
      });
    });
    child.on('close', (code) => {
      resolvePromise({
        exitCode: typeof code === 'number' ? code : 127,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        startedAt,
        endedAt: new Date(),
        spawnError: null,
      });
    });
  });
}

/**
 * 跑**一次**命令并落一份**不可覆盖**的工件。
 *
 * 返回该次运行的记录（含工件路径与 `mayCompare` 所需要的最小字段）。
 *
 * `options.skip`（R-1）：{@link runGate} 判定"前置未满足且未注入"时传入，此时**不执行任何命令**，
 * 落一份 `outcome: 'skipped_missing_prerequisite'` 的记录（`exitCode: null`，无 `failures/` 副本）。
 *
 * dirty **前后各采一次**（R-4）：`dirty`（= 执行前，兼容既有字段）/ `dirtyBefore` / `dirtyAfter` /
 * `dirtyDelta`，使"哪条命令写脏了什么"可逐条归因。
 */
export async function runOnce(options) {
  const root = resolve(options.repoRoot ?? REPO_ROOT);
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const command = String(options.command);
  const cwd = resolve(options.cwd ?? root);
  const stamp = options.stamp ?? formatStamp(new Date());
  const label = options.label ?? null;
  const kind = options.kind ?? 'requested';
  const forCommand = options.forCommand ?? null;
  const graph = options.prerequisiteGraph ?? COMMAND_PREREQUISITES;
  const executedPrereqs = options.executedPrerequisites ?? new Set();
  const skip = options.skip ?? null;

  const candidate = collectCandidate(root);
  const runId = `${stamp}-${candidate.headShort}`;
  const runDir = join(outDir, runId);

  // dirty **执行前**采样（R-4）：复用候选身份那次 porcelain（同一采样点，省一次 git status）。
  const dirtyBefore = dirtyFromSummary(candidate.status, candidate.statusOk, candidate.statusError);
  // 计算源码摘要（命令执行**前**）—— 摘要必须先于任何可能改动工作树的动作。
  const digestBefore = computeSourceDigest(root);

  // 先占住目录：已存在即报错，绝不覆盖（在任何命令**之前**）。
  await mkdirNoClobber(runDir);

  let result;
  if (skip) {
    const now = new Date();
    result = {
      exitCode: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      startedAt: now,
      endedAt: now,
      spawnError: null,
    };
  } else {
    result = await spawnCapture(command, cwd);
  }

  // dirty **执行后**采样（R-4）：与 dirtyBefore 之差即"这条命令写脏了什么"。
  const dirtyAfter = collectDirty(root);
  const dirtyDelta = diffDirty(dirtyBefore, dirtyAfter);
  const digestAfter = computeSourceDigest(root);
  const digestDrift = digestBefore.sha256 !== digestAfter.sha256;
  const prerequisiteStates = collectPrerequisiteStates(root, command, graph, executedPrereqs);

  const record = {
    schemaVersion: 1,
    package: 'FA-BOUND-RUN-LEDGER',
    runId,
    label,
    stamp,
    kind,
    forCommand,
    outcome: skip ? 'skipped_missing_prerequisite' : 'executed',
    skip: skip
      ? { reason: skip.reason, missing: [...skip.missing], hint: skip.hint }
      : null,
    repoRoot: root,
    cwd,
    head: candidate.head,
    headShort: candidate.headShort,
    branch: candidate.branch,
    // `dirty` 保持既有语义 = 命令执行**前**的脏态（R-4 拆出 before/after 两份，另有签名供 R-2 比较）。
    dirty: dirtyBefore,
    dirtyBefore,
    dirtyAfter,
    dirtyDelta,
    // R-3：把脏条目按摘要域分类，域外（如 .task-manifest/**）单独报出 —— 盲区可见、可归因。
    outOfScopeDirty: {
      before: classifyDirtyPaths(dirtyBefore.lines),
      after: classifyDirtyPaths(dirtyAfter.lines),
    },
    prerequisites: prerequisiteStates,
    prerequisiteKey: prerequisiteKeyOf(prerequisiteStates),
    command,
    startedAt: formatIsoLocal(result.startedAt),
    startedAtUtc: result.startedAt.toISOString(),
    endedAt: formatIsoLocal(result.endedAt),
    endedAtUtc: result.endedAt.toISOString(),
    durationMs: result.endedAt.getTime() - result.startedAt.getTime(),
    exitCode: result.exitCode,
    spawnError: result.spawnError,
    digestBefore,
    digestAfter,
    digestDrift,
    digestScopeDecision: DIGEST_SCOPE_DECISION,
    artifactDir: runDir,
    // 失败目录**先定好**再写 meta.json：否则 meta.json 会被写两次，
    // 第二次撞上 writeNoClobber 而报错（或更糟——绕过不可覆盖规则去改写）。
    // **缺前置的跳过不生成 failures/**：它不是一次测试失败（R-1）。
    failureDir: !skip && result.exitCode !== 0 ? join(outDir, 'failures', runId) : null,
  };

  await writeNoClobber(join(runDir, 'summary.txt'), renderSummary(record));
  await writeNoClobber(join(runDir, 'stdout.txt'), result.stdout);
  await writeNoClobber(join(runDir, 'stderr.txt'), result.stderr);
  await writeNoClobber(join(runDir, 'meta.json'), `${JSON.stringify(record, null, 2)}\n`);

  if (record.failureDir !== null) {
    // **额外**整份复制到 failures/：绝不覆盖既有文件（copyArtifactDirNoClobber 逐文件走 wx）。
    await copyArtifactDirNoClobber(runDir, record.failureDir);
  }

  return record;
}

/** 工件 `summary.txt` 的渲染：**按监督要求的顺序**逐项写出。 */
export function renderSummary(record) {
  const lines = [];
  lines.push('=== FA-BOUND-RUN-LEDGER 门禁运行记录 ===');
  lines.push(`RUN_ID: ${record.runId}`);
  if (record.label) lines.push(`LABEL: ${record.label}`);
  lines.push(`REPO_ROOT: ${record.repoRoot}`);
  lines.push(`CWD: ${record.cwd}`);
  lines.push(`BRANCH: ${record.branch}`);
  lines.push(`HEAD: ${record.head}`);
  lines.push(`HEAD_SHORT: ${record.headShort}`);
  lines.push(`KIND: ${record.kind}`);
  lines.push(`FOR_COMMAND: ${record.forCommand ?? '(self)'}`);
  lines.push(`OUTCOME: ${record.outcome}`);
  if (record.skip) {
    lines.push(`MISSING_PREREQUISITE: ${record.skip.missing.join(', ')}`);
    lines.push(`HINT: ${record.skip.hint}`);
  }
  lines.push(`DIRTY_COUNT: ${record.dirty.count}`);
  lines.push(`DIRTY_BY_CODE: ${JSON.stringify(record.dirty.byCode)}`);
  lines.push('DIRTY_LINES:');
  if (record.dirty.lines.length === 0) lines.push('  (clean)');
  for (const line of record.dirty.lines) lines.push(`  ${line}`);
  // R-4：逐命令采 dirty —— 这条命令**前后**各一次的差值，可归因到具体命令。
  lines.push(`DIRTY_BEFORE_COUNT: ${record.dirtyBefore.count}`);
  lines.push(`DIRTY_AFTER_COUNT: ${record.dirtyAfter.count}`);
  lines.push(`DIRTY_DELTA: ${record.dirtyDelta.delta >= 0 ? '+' : ''}${record.dirtyDelta.delta}`);
  lines.push(`DIRTY_ADDED_BY_COMMAND: ${JSON.stringify(record.dirtyDelta.added)}`);
  lines.push(`DIRTY_REMOVED_BY_COMMAND: ${JSON.stringify(record.dirtyDelta.removed)}`);
  // R-3：摘要域外的脏条目（漏报盲区的可见化）。
  lines.push(`DIRTY_OUT_OF_DIGEST_SCOPE_BEFORE: ${JSON.stringify(record.outOfScopeDirty.before.outOfDigestScope)}`);
  lines.push(`DIRTY_OUT_OF_DIGEST_SCOPE_AFTER: ${JSON.stringify(record.outOfScopeDirty.after.outOfDigestScope)}`);
  lines.push(`PREREQUISITE_KEY: ${record.prerequisiteKey}`);
  if (record.prerequisites.length === 0) lines.push('PREREQUISITES: (none)');
  for (const state of record.prerequisites) {
    lines.push(
      `PREREQUISITE: ${state.command} executed=${state.executed} satisfied=${state.satisfied} probe=${state.probe}`,
    );
  }
  lines.push(`COMMAND: ${record.command}`);
  lines.push(`START: ${record.startedAt}`);
  lines.push(`END: ${record.endedAt}`);
  lines.push(`DURATION_MS: ${record.durationMs}`);
  lines.push(`EXIT_CODE: ${record.exitCode === null ? '(not executed)' : record.exitCode}`);
  if (record.spawnError) lines.push(`SPAWN_ERROR: ${record.spawnError}`);
  lines.push(`SOURCE_DIGEST_SCOPE: ${record.digestBefore.scope.join(',')}`);
  lines.push(`SOURCE_DIGEST_EXTENSIONS: ${record.digestBefore.extensions.join(',')}`);
  lines.push(`SOURCE_DIGEST_EXCLUDED_DIRS: ${record.digestBefore.excludedDirs.join(',')}`);
  lines.push(`SOURCE_DIGEST_REGISTERED_EXCLUSIONS: ${record.digestScopeDecision.registeredExclusions.join(',')}`);
  lines.push(`SOURCE_DIGEST_SCOPE_RATIONALE: ${record.digestScopeDecision.rationale}`);
  lines.push(`SOURCE_DIGEST_FILES: ${record.digestBefore.fileCount}`);
  lines.push(`SOURCE_DIGEST_SHA256_BEFORE: ${record.digestBefore.sha256}`);
  lines.push(`SOURCE_DIGEST_SHA256_AFTER: ${record.digestAfter.sha256}`);
  lines.push(`DIGEST_DRIFT: ${record.digestDrift}`);
  lines.push(`STDOUT_FILE: stdout.txt`);
  lines.push(`STDERR_FILE: stderr.txt`);
  lines.push(`ARTIFACT_DIR: ${record.artifactDir}`);
  lines.push(`FAILURE_DIR: ${record.failureDir ?? '(none)'}`);
  lines.push('=== 说明：stdout/stderr 为原始字节，未截断、未 tail；本目录一旦存在即不再被任何运行改写。===');
  return `${lines.join('\n')}\n`;
}

/**
 * 依序跑**一个计划**（{@link resolveGatePlan}），每步各落一份工件。
 *
 * 与"修后只跑一次绑候选的完整门禁"配套：这**一次**调用里，所有命令共享同一候选身份
 * （HEAD / dirty 在每步运行前**各自重采**——若前面的命令改动了工作树，后面的会如实变化，
 * 绝不把不同候选的数字混在一份结论里）。另见逐命令 `dirtyBefore` / `dirtyAfter`（R-4）。
 *
 * - `injectPrerequisites !== false`（默认）：前置换 `pnpm demo:build` 等被**自动注入并跑掉**，
 *   默认四条因此自足（R-1）；
 * - `injectPrerequisites === false`（`--no-prereq`）：不注入；被请求命令的前置若**未满足**，
 *   该步**不执行**，落 `skipped_missing_prerequisite` 记录，运行器退出码 `EXIT_MISSING_PREREQUISITE`
 *   ——**不是**测试失败。
 * - `options.prerequisites`：换一份顺序依赖图（测试用；默认 {@link COMMAND_PREREQUISITES}）。
 */
export async function runGate(options = {}) {
  const root = resolve(options.repoRoot ?? REPO_ROOT);
  const inject = options.injectPrerequisites !== false;
  const graph = options.prerequisites ?? COMMAND_PREREQUISITES;
  const commands = options.commands?.length ? [...options.commands] : [...DEFAULT_COMMANDS];
  const plan = resolveGatePlan(commands, { injectPrerequisites: inject, prerequisites: graph });
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  await mkdir(outDir, { recursive: true });
  // 一个计划共用同一时间戳底座；多步时逐步加序号，避免同一 stamp 撞名（单步保持原样）。
  const baseStamp = options.stamp ?? formatStamp(new Date());
  const executedPrereqs = new Set();
  const runs = [];
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index];
    const stamp = plan.length > 1 ? `${baseStamp}-${index + 1}` : baseStamp;
    const skip = (!inject && step.kind === 'requested')
      ? prerequisiteSkipFor(root, step.command, graph)
      : null;
    const record = await runOnce({
      command: step.command,
      kind: step.kind,
      forCommand: step.forCommand,
      outDir,
      cwd: options.cwd,
      repoRoot: options.repoRoot,
      stamp,
      label: options.label,
      prerequisiteGraph: graph,
      executedPrerequisites: executedPrereqs,
      skip,
    });
    if (step.kind === 'prerequisite' && record.outcome === 'executed') executedPrereqs.add(step.command);
    runs.push(record);
  }
  const stepExitCode = (run) => (run.outcome === 'skipped_missing_prerequisite'
    ? EXIT_MISSING_PREREQUISITE
    : (run.exitCode ?? 0));
  const firstNonZero = runs.find((run) => stepExitCode(run) !== 0);
  const exitCode = runs.length === 1
    ? stepExitCode(runs[0])
    : (firstNonZero ? stepExitCode(firstNonZero) : 0);
  return { runs, outDir, exitCode, plan };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { commands: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cmd' || arg === '--command') options.commands.push(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--cwd') options.cwd = argv[++i];
    else if (arg === '--repo-root') options.repoRoot = argv[++i];
    else if (arg === '--stamp') options.stamp = argv[++i];
    else if (arg === '--label') options.label = argv[++i];
    else if (arg === '--no-prereq' || arg === '--no-prerequisites') options.noPrereq = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

/** `--list` 打印的内容：被请求的默认命令 + 自动注入的前置 + 顺序依赖登记。 */
export function renderPlanListing(commands) {
  const plan = resolveGatePlan(commands);
  const lines = ['# 默认被请求命令:', ...commands];
  lines.push('# 实际执行计划（前置已注入）:', ...plan.map(
    (step, i) => `  ${i + 1}. [${step.kind}] ${step.command}`,
  ));
  lines.push(`# 顺序依赖: ${PREREQUISITE_ORDER_NOTE}`);
  return lines.join('\n');
}

const USAGE = [
  '用法: node scripts/gate/run.mjs [选项]',
  '',
  '  --cmd <命令>     追加一条要跑的命令（可重复；不给则用默认四条）',
  '  --out <目录>     工件根（默认 .dev-evidence/gate）',
  '  --cwd <目录>     命令的工作目录（默认仓库根）',
  '  --repo-root <目录>  候选仓库根（默认本脚本上溯两级；测试用）',
  '  --stamp <串>     固定时间戳分量（复现 / 测试用）',
  '  --label <串>     给这次运行加个标签',
  '  --no-prereq      不自动注入前置；缺前置的条目记结构化跳过（不记成测试失败）',
  '  --list           打印默认命令与实际执行计划（含注入的前置与顺序登记）',
  '  -h, --help       本帮助',
  '',
  `默认命令: ${DEFAULT_COMMANDS.join(' | ')}`,
  `顺序依赖: ${PREREQUISITE_ORDER_NOTE}`,
].join('\n');

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gate_runner_error: ${String(error.message)}\n`);
    process.exit(1);
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (options.list) {
    process.stdout.write(`${renderPlanListing(DEFAULT_COMMANDS)}\n`);
    process.exit(0);
  }
  try {
    const { runs, exitCode } = await runGate({
      commands: options.commands,
      outDir: options.out,
      cwd: options.cwd,
      repoRoot: options.repoRoot,
      stamp: options.stamp,
      label: options.label,
      injectPrerequisites: !options.noPrereq,
    });
    for (const run of runs) {
      process.stdout.write(
        `[gate] ${run.runId} exit=${run.exitCode} outcome=${run.outcome} kind=${run.kind}`
        + ` head=${run.headShort} dirty=${run.dirty.count}->${run.dirtyAfter.count} -> ${run.artifactDir}\n`,
      );
      if (run.skip) process.stdout.write(`[gate] 缺前置 ${run.skip.missing.join(', ')}: ${run.skip.hint}\n`);
      if (run.failureDir) process.stdout.write(`[gate] 失败日志另存: ${run.failureDir}\n`);
    }
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`gate_runner_error: ${String(error?.code ?? '')} ${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
}
