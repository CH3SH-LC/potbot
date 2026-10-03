/**
 * FA-E2E-DEVICE-SMOKE —— 设备冒烟脚本的**结构断言**
 *
 * 本文件**不碰真机**：它只断言 `scripts/device/smoke.{cmd,mjs}` 存在、接口正确、
 * 失败码如实、真机纪律（不许卸载 / 不许 pm clear / 不许改系统设置 / 不许 root /
 * 不许撤掉别人正在用的反向映射）在源码里可机器检。
 *
 * 为什么要有这一层：冒烟脚本的价值在于「跑出来的数字可信」。一个会**悄悄成功**、
 * 或者在失败时返回 0 的脚本，比没有脚本更糟——它会把没做过的事写成做过。
 * 因此这里逐条把「诚实性」钉成断言。
 *
 * 运行时断言走 `tests/device/smoke-probe.mjs`（真实 Node 加载器）
 * ——vitest 自己的 transform 管线装载该 `.mjs` 会抛 SyntaxError，
 * 而 `vitest.config.ts` 属于冻结身份、结构性测试不得修改它。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SMOKE_MJS = join(REPO_ROOT, 'scripts', 'device', 'smoke.mjs');
const SMOKE_CMD = join(REPO_ROOT, 'scripts', 'device', 'smoke.cmd');
const SMOKE_PROBE = join(HERE, 'smoke-probe.mjs');

const mjsSource = (): string => readFileSync(SMOKE_MJS, 'utf8');
const cmdSource = (): string => readFileSync(SMOKE_CMD, 'utf8');

interface Probe {
  readonly routes: readonly string[];
  readonly forbidden: readonly string[];
  readonly hasRunSmoke: boolean;
  readonly hasParsePidsContract: boolean;
  readonly conflict: Readonly<Record<string, boolean>>;
  readonly pids: Readonly<Record<string, { threw: boolean; code: string | null; value?: unknown }>>;
}

let probe: Probe;

beforeAll(() => {
  const output = execFileSync(process.execPath, [SMOKE_PROBE], { encoding: 'utf8', timeout: 30_000 });
  probe = JSON.parse(output) as Probe;
});

describe('FA-E2E-DEVICE-SMOKE —— 脚本存在性与接口', () => {
  it('三个文件都在（.mjs 装载器 + .cmd 包装器 + 只读探针）', () => {
    expect(existsSync(SMOKE_MJS)).toBe(true);
    expect(existsSync(SMOKE_CMD)).toBe(true);
    expect(existsSync(SMOKE_PROBE)).toBe(true);
    expect(mjsSource().length).toBeGreaterThan(1000);
  });

  it('.cmd 包装器用 node 跑 smoke.mjs，并原样回传退出码（不吞错）', () => {
    const source = cmdSource();
    expect(source).toMatch(/node\s+"%~dp0smoke\.mjs"\s+%\*/);
    expect(source).toMatch(/exit\s+\/b\s+%ERRORLEVEL%/);
    // 找不到 node 时必须非 0 退出，不能"看起来跑过了"。
    expect(source).toMatch(/where node/);
    expect(source).toMatch(/exit\s+\/b\s+1/);
  });

  it('导出可被外部断言的常量：冒烟路由、禁用写操作、冲突判据', () => {
    expect(Array.isArray(probe.routes)).toBe(true);
    expect(Array.isArray(probe.forbidden)).toBe(true);
    expect(probe.hasRunSmoke).toBe(true);
    expect(probe.hasParsePidsContract).toBe(true);
  });

  it('冒烟覆盖的三条新路由都在清单里（且含 /health 作为基线）', () => {
    expect(probe.routes).toContain('/health');
    expect(probe.routes).toContain('/api/documents/status');
    expect(probe.routes).toContain('/api/research/status');
    expect(probe.routes).toContain('/api/roles/reachability');
  });
});

describe('FA-E2E-DEVICE-SMOKE —— 真机纪律（机器可检）', () => {
  /**
   * 剔除禁用清单声明块后，抽出所有**字符串字面量**——也就是真正会被执行/下发的命令面。
   *
   * 必须**跳过注释**：文档里写着「不 `pm clear`」这种句子，朴素子串扫描会把"声明不做"
   * 当成"做了"，是自证式假阳性。这里用一个极小的词法扫描器逐字符走：
   * 遇到注释整段跳过，遇到字符串字面量才收内容。
   */
  function executableLiteralText(): string {
    const source = mjsSource();
    const text = source.replace(/export const FORBIDDEN_DEVICE_OPS = Object\.freeze\(\[[\s\S]*?\]\);/, '');
    // 先确认清单声明那段真的被剔除了，否则后面的扫描是自证式假阳性。
    expect(text).not.toBe(source);
    const literals: string[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i] as string;
      const next = text[i + 1];
      if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
      if (ch === '/' && next === '/') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        let buffer = '';
        while (j < text.length && text[j] !== ch) {
          if (text[j] === '\\') { buffer += text[j + 1] ?? ''; j += 2; continue; }
          if (ch === '`' && text[j] === '$' && text[j + 1] === '{') { const close = text.indexOf('}', j + 2); j = close < 0 ? text.length : close + 1; continue; }
          buffer += text[j]; j += 1;
        }
        literals.push(buffer);
        i = j + 1;
        continue;
      }
      i += 1;
    }
    return literals.join('\n');
  }

  it('被下发的命令面里不出现任何被禁的设备写操作（注释里的"不做"不算）', () => {
    const literals = executableLiteralText();
    const hits = probe.forbidden.filter((needle) => literals.includes(needle));
    expect(hits).toEqual([]);
    // 用例本身不能是空断言：正常字面量必须被抽到，禁用清单必须非空。
    expect(literals).toContain('POTBOT_PID_EXIT');
    expect(probe.forbidden.length).toBeGreaterThan(0);
    for (const needle of ['pm clear', 'pm uninstall', 'killforward']) {
      expect(probe.forbidden).toContain(needle);
    }
  });

  it('★判别力：把任一禁用项写成命令字符串，扫描必须报出来', () => {
    const literals = executableLiteralText();
    const poisoned = `${literals}\nshell:pm clear com.potbot.demo\n`;
    const hits = probe.forbidden.filter((needle) => poisoned.includes(needle));
    expect(hits).toContain('pm clear');
  });

  it('R169 的人工项被登记为 not_done，未被写成已完成', () => {
    const source = mjsSource();
    expect(source).toMatch(/r169Manual/);
    expect(source).toMatch(/status: 'not_done'/);
    expect(source).toMatch(/R169/);
  });
});

describe('FA-E2E-DEVICE-SMOKE —— 幂等反向映射冲突的判据', () => {
  it('只对「invalid_service_length + reverse_setup 未定」判为冲突', () => {
    expect(probe.conflict['real']).toBe(true);
  });

  it('★判别力：别的错误码、别的步骤、别的状态、ready 报告、空值都不得判为冲突', () => {
    expect(probe.conflict['wrongCode']).toBe(false);
    expect(probe.conflict['ready']).toBe(false);
    expect(probe.conflict['otherStep']).toBe(false);
    expect(probe.conflict['stepNotUnknown']).toBe(false);
    expect(probe.conflict['nullish']).toBe(false);
    expect(probe.conflict['undefinedish']).toBe(false);
  });
});

describe('FA-E2E-DEVICE-SMOKE —— 失败码如实', () => {
  it('判定只在所有必需步骤 ok 时才可能是 pass；否则 partial', () => {
    const source = mjsSource();
    expect(source).toMatch(/const required = \['apkBuild', 'serverBuild', 'server', 'routes', 'device'\]/);
    expect(source).toMatch(/required\.every\(\(key\) => summary\.steps\[key\]\?\.status === 'ok'\)/);
    expect(source).toMatch(/summary\.verdict = allOk \? 'pass' : 'partial'/);
  });

  it('退出码 0 只在 pass；否则 2（脚本自身异常为 fail，也不返回 0）', () => {
    const source = mjsSource();
    expect(source).toMatch(/exitCode: summary\.verdict === 'pass' \? 0 : 2/);
    expect(source).toMatch(/summary\.verdict = 'fail'/);
  });

  it('装机 / 映射 / 手机到宿主 / 冷启动 四要件齐全才算设备步骤 ok', () => {
    const source = mjsSource();
    expect(source).toMatch(/acknowledged === true/);
    expect(source).toMatch(/matchesLocal === true/);
    expect(source).toMatch(/mappingVerified === true/);
    expect(source).toMatch(/sameHostInstance === true/);
    expect(source).toMatch(/processRunning === true/);
  });

  it('回退冷启动复用既有 honor-connect 的服务常量与解析器（不另立语义）', () => {
    const source = mjsSource();
    for (const symbol of ['PHONE_HEALTH_SERVICE', 'STOP_SERVICE', 'PID_SERVICE', 'START_SERVICE', 'parseReverseList', 'parsePhoneHealth', 'parseExitMarker', 'invokeHonorNative']) {
      expect(source).toContain(symbol);
    }
    expect(source).toMatch(/from '\.\.\/demo\/honor-connect\.mjs'/);
    // `parsePids` 未被 honor-connect 导出：本地复刻必须写明「逐字相同契约」，不得放宽。
    expect(source).toMatch(/parsePidsContract/);
    expect(source).toMatch(/没有导出/);
  });

  it('PID 复刻解析器与 honor-connect 契约同构：接受去重后的正整数，拒绝空正文/非 0 退出/非正整数', () => {
    expect(probe.pids['two']?.threw).toBe(false);
    expect(probe.pids['two']?.value).toEqual(expect.objectContaining({ pids: [1234, 5678], running: true }));
    expect(probe.pids['dedup']?.value).toEqual([1234]);
    expect(probe.pids['emptyBody']?.threw).toBe(true);
    expect(probe.pids['nonzeroExit']?.threw).toBe(true);
    expect(probe.pids['zeroPid']?.threw).toBe(true);
    expect(probe.pids['alpha']?.threw).toBe(true);
    expect(probe.pids['emptyBody']?.code).toBe('potbot_pid_not_verified');
  });

  it('未验证项不被写成已验证：启动日志完整性明确标注未验证', () => {
    expect(mjsSource()).toMatch(/启动日志是否完整\*\*未验证\*\*/);
  });
});
