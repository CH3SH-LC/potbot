/**
 * WCF-D53 / design-05 **WF-090**（打印交接）—— 状态语义的验收测试。
 *
 * ## 核心断言
 *
 * * **没有任何路径能宣称"已打印"**：返回类型上 `printed` 的字面量类型就是 `false`，
 *   本文件用运行时断言把它钉住（`outcome.printed === false` 对**每一种**结局都成立）。
 * * 成功的交接**只到 `handed_off`**，且 `stateMeaning` 与任务书 §12 原文一致。
 * * 目标不存在 ⇒ 停在 `prepared`；摘要不符 ⇒ `invalidated`，**都不假装交接过**。
 * * **Android 上交接通路不存在** ⇒ `prepared` + `handoff_unavailable`，
 *   边界里必须写明"手机端未实现、未验证"。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  EXTERNAL_ACTION_STATE_MEANINGS,
  PRINT_HANDOFF_BOUNDARIES,
  createUnsupportedPrintHandoff,
  createWindowsShellPrintHandoff,
  handOffPath,
  handOffToPrint,
} from '../../../apps/demo/rendering/index.js';
import type {
  ExternalActionState,
  PrintHandoffOpenResult,
  PrintHandoffOutcome,
  PrintHandoffPort,
} from '../../../apps/demo/rendering/index.js';

import { D53_EVIDENCE_DIR, makeRealPdf } from './support.js';

beforeAll(() => {
  mkdirSync(D53_EVIDENCE_DIR, { recursive: true });
});

/** 假交接端口：记录调用并可固定成功/失败。 */
function fakePort(
  platform: PrintHandoffPort['platform'],
  result: PrintHandoffOpenResult,
): PrintHandoffPort & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  return {
    platform,
    calls,
    async open(targetPath: string) {
      calls.push(targetPath);
      return result;
    },
  };
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('WF-090 七态口径与硬约束', () => {
  it('七态齐备且与任务书 §12 措辞一致', () => {
    const states: readonly ExternalActionState[] = [
      'prepared', 'handed_off', 'submitted', 'confirmed_complete',
      'result_unknown', 'user_reported_complete', 'invalidated',
    ];
    for (const state of states) {
      expect(EXTERNAL_ACTION_STATE_MEANINGS[state], `缺 ${state} 的释义`).toBeTruthy();
    }
    expect(EXTERNAL_ACTION_STATE_MEANINGS.handed_off).toBe('已打开目标应用或页面，不表示用户提交');
    expect(EXTERNAL_ACTION_STATE_MEANINGS.confirmed_complete).toBe('有可信回执或读回证据证明目标动作完成');
    expect(Object.keys(EXTERNAL_ACTION_STATE_MEANINGS)).toHaveLength(7);
  });

  it('边界声明里必须写明「手机端未验证」与「本批只到已交接」', () => {
    const joined = PRINT_HANDOFF_BOUNDARIES.join('\n');
    expect(joined).toContain('已交接');
    expect(joined).toContain('手机端');
    expect(joined).toContain('未验证');
  });
});

describe('WF-090 成功交接：只到 handed_off，绝不宣称已打印', () => {
  it('端口打开成功 → state=handed_off，printed=false，handler 与原始证据带出', async () => {
    const pdf = makeRealPdf('handoff-ok.pdf', 2);
    const port = fakePort('windows-desktop', {
      opened: true,
      handler: 'MSEdgePDF :: msedge.exe -- "%1"',
      detail: '系统已受理打开请求（已交接，不代表已打印）',
      raw: 'assoc .pdf -> rc=0 .pdf=MSEdgePDF\nftype MSEdgePDF -> rc=0 msedge.exe -- "%1"\nstart "" x -> rc=0',
    });

    const outcome = await handOffToPrint(port, {
      pdfPath: pdf,
      sha256: sha256(readFileSync(pdf)),
    });

    writeFileSync(join(D53_EVIDENCE_DIR, 'handoff-ok.outcome.json'),
      JSON.stringify(outcome, null, 2), 'utf8');

    expect(outcome.state).toBe('handed_off');
    expect(outcome.stateMeaning).toBe(EXTERNAL_ACTION_STATE_MEANINGS.handed_off);
    expect(outcome.printed).toBe(false);
    expect(outcome.claim).toContain('不代表已打印');
    expect(outcome.platform).toBe('windows-desktop');
    if (outcome.state !== 'handed_off') return;
    expect(outcome.handler).toContain('MSEdgePDF');
    expect(outcome.raw).toContain('start ""');
  });

  it('每一种结局的 printed 都是 false（类型 + 运行时双保险）', async () => {
    const outcomes: PrintHandoffOutcome[] = [];

    const pdf = makeRealPdf('handoff-printed-flag.pdf', 1);
    outcomes.push(await handOffToPrint(fakePort('windows-desktop', {
      opened: true, handler: 'x', detail: 'ok', raw: 'raw',
    }), { pdfPath: pdf, sha256: sha256(readFileSync(pdf)) }));

    outcomes.push(await handOffPath(
      fakePort('windows-desktop', { opened: true, handler: 'x', detail: 'ok', raw: 'raw' }),
      { pdfPath: join(D53_EVIDENCE_DIR, 'absent-for-flag.pdf') },
    ));

    for (const outcome of outcomes) {
      expect(outcome.printed).toBe(false);
      expect(outcome.state).not.toBe('confirmed_complete');
      expect(outcome.state).not.toBe('submitted');
    }
  });
});

describe('WF-090 未交接：结构化失败，不假装交接过', () => {
  it('目标不存在 → prepared + target_missing', async () => {
    const port = fakePort('windows-desktop', { opened: true, handler: null, detail: 'x', raw: 'x' });
    const outcome = await handOffPath(port, { pdfPath: join(D53_EVIDENCE_DIR, 'nope.pdf') });

    expect(outcome.state).toBe('prepared');
    expect(outcome.printed).toBe(false);
    if (outcome.state === 'handed_off') return;
    expect(outcome.failure.kind).toBe('target_missing');
    expect(port.calls, '目标不存在时不该去打开').toHaveLength(0);
  });

  it('盘上摘要与读回时不一致 → invalidated + target_digest_mismatch', async () => {
    const pdf = makeRealPdf('handoff-digest.pdf', 1);
    const outcome = await handOffPath(
      fakePort('windows-desktop', { opened: true, handler: null, detail: 'x', raw: 'x' }),
      { pdfPath: pdf, expectedSha256: 'deadbeef'.repeat(8) },
    );

    expect(outcome.state).toBe('invalidated');
    expect(outcome.printed).toBe(false);
    if (outcome.state === 'handed_off') return;
    expect(outcome.failure.kind).toBe('target_digest_mismatch');
  });

  it('系统处理器打开失败 → prepared + open_failed', async () => {
    const pdf = makeRealPdf('handoff-openfail.pdf', 1);
    const outcome = await handOffToPrint(
      fakePort('windows-desktop', { opened: false, handler: 'x', detail: '未关联处理器', raw: 'rc=1' }),
      { pdfPath: pdf, sha256: sha256(readFileSync(pdf)) },
    );

    expect(outcome.state).toBe('prepared');
    if (outcome.state === 'handed_off') return;
    expect(outcome.failure.kind).toBe('open_failed');
  });
});

describe('WF-090 平台边界：Android 上没有通路', () => {
  it('android 端口 → prepared + handoff_unavailable，并点名 PrintManager 缺失', async () => {
    const pdf = makeRealPdf('handoff-android.pdf', 1);
    const outcome = await handOffToPrint(createUnsupportedPrintHandoff('android'), {
      pdfPath: pdf,
      sha256: sha256(readFileSync(pdf)),
    });

    expect(outcome.state).toBe('prepared');
    expect(outcome.platform).toBe('android');
    expect(outcome.printed).toBe(false);
    if (outcome.state === 'handed_off') return;
    expect(outcome.failure.kind).toBe('handoff_unavailable');
    expect(outcome.failure.detail ?? '').toContain('PrintManager');
    expect(outcome.boundaries.join('\n')).toContain('手机端');
  });
});

describe('WF-090 Windows 端口：关联查询失败也如实降级', () => {
  it('没有登记的处理器时**不算已交接**（`start` 的 rc=0 不能单独作数）', async () => {
    const port = createWindowsShellPrintHandoff({
      queryAssoc: () => ({ progId: '', command: '(none)', raw: 'reg query UserChoice -> rc=1 未找到关联' }),
      openFile: () => ({ status: 0, out: '(注入) 未真正启动任何程序' }),
    });

    const pdf = makeRealPdf('handoff-realport.pdf', 1);
    const opened = await port.open(pdf);

    // 关键：shell 说"受理了"，但系统里没有 `.pdf` 处理器 ⇒ **交接目标不存在** ⇒ 不是已交接。
    expect(opened.opened).toBe(false);
    expect(opened.handler).toBeNull();
    expect(opened.detail).toContain('交接目标不存在');
    expect(opened.raw).toContain('未找到关联');
  });

  it('处理器已登记且 shell 受理 → 才算已交接，且 handler 被如实记下', async () => {
    const port = createWindowsShellPrintHandoff({
      queryAssoc: () => ({
        progId: 'MSEdgePDF',
        command: 'MSEdgePDF="...msedge.exe" --single-argument %1',
        raw: 'reg query UserChoice -> rc=0 ProgId REG_SZ MSEdgePDF',
      }),
      openFile: () => ({ status: 0, out: '(注入)' }),
    });

    const pdf = makeRealPdf('handoff-realport-ok.pdf', 1);
    const opened = await port.open(pdf);

    expect(opened.opened).toBe(true);
    expect(opened.handler).toContain('MSEdgePDF');
    expect(opened.raw).toContain('UserChoice');
  });

  it('打开命令非零退出码 → opened=false（不谎报已交接）', async () => {
    const port = createWindowsShellPrintHandoff({
      queryAssoc: () => ({ progId: 'P', command: 'c', raw: 'assoc ok' }),
      openFile: () => ({ status: 1, out: '拒绝访问' }),
    });
    const opened = await port.open(join(D53_EVIDENCE_DIR, 'whatever.pdf'));
    expect(opened.opened).toBe(false);
    expect(opened.detail).toContain('非零');
  });
});
