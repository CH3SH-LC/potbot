/**
 * FA-VERIFY-WAVE-10 · 「预算额度跨**真进程**重启不回升」的独立进程探针。
 *
 * 用法：`node --experimental-transform-types --experimental-loader ./node-ts-loader.mjs \
 *        budget-restart-probe.mjs <admit|inspect> <runDir>`
 *
 * 两个模式各跑在**各自独立的 `node` 进程**里（PID 不同、内存不共享），唯一共享的是 `<runDir>` 下的
 * JSONL 流水。探针直接 import 仓库源码，不依赖预编译产物。
 *
 * 诚实边界：本探针只覆盖**同一运行目录**、**顺序执行的两个进程**（不是并发追加）。
 * 两个真实进程**并发**追加同一条 JSONL 的原子性**未实测**（与 budget-wiring.ts 头部声明一致）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProductBudgetWiring } from '../../../apps/demo/server/budget-wiring.js';

const [mode, runDir] = process.argv.slice(2);
if (mode !== 'admit' && mode !== 'inspect') {
  process.stderr.write('用法：node budget-restart-probe.mjs <admit|inspect> <runDir>\n');
  process.exit(2);
}

const CONFIG = Object.freeze({
  task_calls: 10,
  model_calls: 10,
  tool_calls: 10,
  tokens: 100000,
  cost_micros: 100000,
  concurrency: 4,
  retries: 10,
  time: 100000,
});

const budget = new ProductBudgetWiring({ config: CONFIG, runDir });
const journalPath = join(runDir, 'budget-journal.jsonl');
const journalLines = () =>
  existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '').length
    : 0;

const emit = (extra) => {
  process.stdout.write(
    `${JSON.stringify({
      mode,
      pid: process.pid,
      used_task_calls: budget.ledger.used('task_calls'),
      journalLines: journalLines(),
      ...extra,
    })}\n`,
  );
};

if (mode === 'admit') {
  // **不带 key**（省略）——服务端必须代生成身份并照常落盘。
  const outcome = budget.admit({ charges: { task_calls: 3 } });
  // 反向对照：客户端若自报一个巨大的量，也**不得**改变被扣的实际数量（服务端已在上游确定 charges；
  // 这里直接对 admit 喂 3，验证"落盘量 = 实际被扣量"）。
  emit({
    admitted: outcome.allowed,
    charged_task_calls: outcome.allowed ? outcome.charged['task_calls'] : null,
  });
  process.exit(0);
}

// inspect 模式：**全新进程 + 全新台账**，只把同一份运行目录交给它。
// 先记下**探针申请之前**的已用量，再申请 8 笔（3 + 8 = 11 > 上限 10）⇒ 必须被拒，
// 证明恢复回来的用量真的在参与判定。（两个数分开报，避免"探针自己把 used 抬上去"混淆判据。）
const usedBeforeProbe = budget.ledger.used('task_calls');
const probe = budget.admit({ charges: { task_calls: 8 } });
emit({
  used_before_probe: usedBeforeProbe,
  restore_lowered: budget.restoreReport.lowered,
  fresh_probe_allowed: probe.allowed,
  fresh_probe_would_exceed: probe.allowed ? null : probe.would_exceed,
});
process.exit(0);
