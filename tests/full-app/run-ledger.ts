/**
 * FA-Q —— 门禁运行台账（外部监督 P3 要求：门禁记录必须**绑运行身份**）
 *
 * 监督意见：`FA-X/selfcheck-final.txt` 记 `827 pass + 1 fail, EXIT=1`，而同目录另一份记 828 pass；
 * **不得把二者合并**。根因是：门禁日志**按文件名原地覆盖、且不记 HEAD**，于是"同名不同内容"、
 * "同名不同候选"都不可区分。
 *
 * 因此本台账为**每次运行**记录：候选(HEAD/工作树) + 时间 + 原始日志路径 + 退出码 + 命令。
 * 判据：任两条运行的"数字"只有在 **HEAD + 命令 + 时间** 都对得上时才允许比较。
 *
 * 纯数据，不 import 产品实现。
 */

export interface GateRun {
  readonly id: string;
  /** 归属：本包（FA-Q）或他包（复核用） */
  readonly owner: string;
  readonly at: string;
  /** 候选身份：HEAD sha（未记录则显式写 'NOT_RECORDED'） */
  readonly head: string;
  readonly head_subject: string;
  /** 工作树脏文件数（未记录写 -1） */
  readonly worktree_dirty_files: number;
  readonly command: string;
  readonly exit_code: number;
  readonly raw_log: string;
  readonly summary: string;
  /** 该次运行是否可被独立复核者复算（日志仍在且身份齐全） */
  readonly reproducible: boolean;
}

export const GATE_RUNS: readonly GateRun[] = [
  {
    id: 'FQ-run1-tsc',
    owner: 'FA-Q',
    at: '2026-10-03T05:19:27+0800',
    head: '3c44540ffff25e275e6468f0f7664c5d28b4e2e6',
    head_subject: 'chore: seed 基线',
    worktree_dirty_files: -1,
    command: 'node node_modules/typescript/bin/tsc --noEmit',
    exit_code: 2,
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/selfcheck-tsc.txt',
    summary: '项目 tsc 红，但 tests/full-app 贡献错误 = 0；全部错误在并发流文件（src/plugins、src/memory 等）',
    reproducible: true,
  },
  {
    id: 'FQ-run1-vitest',
    owner: 'FA-Q',
    at: '2026-10-03T05:17:02+0800',
    head: '3c44540ffff25e275e6468f0f7664c5d28b4e2e6',
    head_subject: 'chore: seed 基线',
    worktree_dirty_files: -1,
    command: 'node node_modules/vitest/vitest.mjs run --configLoader native tests/full-app',
    exit_code: 0,
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/selfcheck-vitest-full-app.txt',
    summary: '3 files passed；43 passed / 3 skipped',
    reproducible: true,
  },
  {
    id: 'FQ-run2-tsc',
    owner: 'FA-Q',
    at: '2026-10-03T10:51:37+0800',
    head: '99125dbc348113556cd3e38107e1c5a27c7fdf2e',
    head_subject: 'feat: 完整 App 第六波 — 关闭 design-05 多处未通子项 + 三工具接入口 + I-2 落地',
    worktree_dirty_files: 8,
    command: 'node node_modules/typescript/bin/tsc --noEmit',
    exit_code: 0,
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/selfcheck-run2-20261003T105132.txt',
    summary: '项目 tsc 绿（exit 0）',
    reproducible: true,
  },
  {
    id: 'FQ-run2-vitest',
    owner: 'FA-Q',
    at: '2026-10-03T10:51:56+0800',
    head: '99125dbc348113556cd3e38107e1c5a27c7fdf2e',
    head_subject: 'feat: 完整 App 第六波 — 关闭 design-05 多处未通子项 + 三工具接入口 + I-2 落地',
    worktree_dirty_files: 8,
    command: 'node node_modules/vitest/vitest.mjs run --configLoader native tests/full-app',
    exit_code: 0,
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/selfcheck-run2-20261003T105132.txt',
    summary: '3 files passed；43 passed / 3 skipped',
    reproducible: true,
  },
  {
    id: 'FQ-run3-gates',
    owner: 'FA-Q',
    at: '2026-10-03T10:54:29+0800',
    head: '99125dbc348113556cd3e38107e1c5a27c7fdf2e',
    head_subject: 'feat: 完整 App 第六波 — 关闭 design-05 多处未通子项 + 三工具接入口 + I-2 落地',
    worktree_dirty_files: 21,
    command: 'tsc --noEmit ； vitest run --configLoader native tests/full-app',
    exit_code: 0,
    raw_log: '.dev-evidence/full-app/FA-20261003-A/Q/selfcheck-run3-20261003T105429.txt',
    summary: 'tsc EXIT=0；vitest EXIT=0，4 files passed；55 passed / 3 skipped（矩阵第二次修订后）',
    reproducible: true,
  },
  {
    id: 'FX-demo-vitest',
    owner: 'FA-X',
    at: '2026-10-03T10:15:55+0800',
    head: '5b6913e',
    head_subject: 'feat: 完整 App 第五波 — KRN-07/09 接线 + 产品入口推广到三种办公格式（H4 大部）',
    worktree_dirty_files: -1,
    command: 'node node_modules/vitest/vitest.mjs run --config vitest.demo.config.ts --configLoader native',
    exit_code: 0,
    raw_log: '.task-manifest/outputs/FA-X/selfcheck-vitest-demo.txt',
    summary: '51 files passed / 2 skipped；828 passed / 5 skipped（Start 10:15:55，mtime 10:19:01）',
    reproducible: true,
  },
  {
    id: 'FX-final',
    owner: 'FA-X',
    at: '2026-10-03T10:30:55+0800',
    head: 'NOT_RECORDED',
    head_subject: '（日志内未记 HEAD；FA-X/completion.md 自称基线 HEAD=5b6913e）',
    worktree_dirty_files: -1,
    command: '（4 条：tsc / tsc -p tsconfig.demo / vitest src/adapters / vitest demo）',
    exit_code: 0,
    raw_log: '.task-manifest/outputs/FA-X/selfcheck-final.txt',
    summary:
      '现内容：4 条全 EXIT=0；demo 828 passed / 5 skipped。**mtime 10:37:40 晚于监督 10:26 复核**——该文件被原地覆盖。',
    reproducible: false,
  },
];

/**
 * 外部监督 10:26 复核时**引用**但**现已不存在**的一条记录。
 * 它不可复算——这正是"门禁日志不绑运行身份"的直接后果。
 */
export interface CitedButUnrecoverable {
  readonly cited_by: string;
  readonly cited_at: string;
  readonly claimed: string;
  readonly status: 'not_present_in_current_outputs';
  readonly explanation: string;
}

export const FA_X_CITED_DISCREPANCY: CitedButUnrecoverable = {
  cited_by: '外部监督 复核（2026-10-03 10:26）',
  cited_at: '2026-10-03T10:26+08:00',
  claimed: 'FA-X/selfcheck-final.txt 记 827 passed + 1 failed，EXIT=1',
  status: 'not_present_in_current_outputs',
  explanation:
    '在当前 FA-X 全部产物中检索 827 / "1 failed" / EXIT=1 均 0 命中；selfcheck-final.txt 现内容为 828 passed / EXIT=0，' +
    '其 mtime(10:37:40) 晚于监督复核时刻(10:26)。判定：该 827+1fail 快照已被**原地覆盖且不可恢复**。' +
    '同目录两"份"数字不得合并——它们是**不同命令、不同时刻**的两次运行；且 selfcheck-final.txt 未记录 HEAD，' +
    '无法证明它跑在哪个候选上。这与 completion.md 自称 HEAD=5b6913e 之间**没有**可核对绑定。',
};

/** 判据：两条运行的"数字"只有在 HEAD + 命令 都相同时才可比较。 */
export function mayCompare(a: GateRun, b: GateRun): boolean {
  return a.head !== 'NOT_RECORDED' && b.head !== 'NOT_RECORDED' && a.head === b.head && a.command === b.command;
}
