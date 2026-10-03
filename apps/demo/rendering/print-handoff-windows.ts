/**
 * {@link PrintHandoffPort} 的**真实实现（Windows 桌面）**：把 PDF 交给系统默认处理器。
 *
 * ## "交接"的证据是什么
 *
 * 一次交接由**三样**证据组成，全部原样记进 `raw`：
 * 1. `assoc .pdf` —— 系统登记的 `.pdf` 关联 ProgID；
 * 2. `ftype <progid>` —— 该 ProgID 的打开命令（有处理器 = 交接目标存在）；
 * 3. `cmd /c start "" <pdf>` —— 实际交给系统的动作与退出码。
 *
 * 这三样只证明「**已交接**」——**不证明**"打印了"、也不证明"用户提交了"。
 * 所以本端口只喂给 {@link import('./print-handoff.js').handOffPath}，
 * 由它产出 `state: 'handed_off'` 且 `printed: false`。
 *
 * ## 不做的事
 *
 * * **不用 `-Verb Print`**：那会把文件直接送进打印队列（真实的打印副作用），
 *   而本批拿不到任何回执，无法区分"已提交"与"结果未知"——**宁可不做**。
 * * **不声称打印**：见上。
 */

import { spawnSync } from 'node:child_process';

import type { PrintHandoffOpenResult, PrintHandoffPlatform, PrintHandoffPort } from './print-handoff.js';

/**
 * 用 `cmd /c` 跑一个命令，返回合并后的输出与退出码。
 *
 * 两处踩过的坑：
 * 1. **不能用 `encoding: 'utf8'`**：中文控制台是 GBK，按 UTF-8 解出来是乱码
 *    （`û��Ϊ��չ�� .pdf ...`）。这里收 Buffer 再用 `TextDecoder('gbk')` 解。
 * 2. **参数里别带引号**：Node 用反斜杠转义内层引号，而 cmd.exe 不认这种转义，
 *    结果整条 `reg query "..."` 静默失败（退出码 1、stdout 空）。命令与参数都**不含空格**，
 *    所以分开传、不加引号即可。
 */
function cmd(args: readonly string[]): { readonly status: number | null; readonly out: string } {
  const done = spawnSync('cmd', ['/c', ...args], { windowsHide: true, timeout: 30_000 });
  const decode = (buffer: Buffer | null): string => {
    if (buffer === null) return '';
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  };
  const out = `${decode(done.stdout)}${decode(done.stderr)}`.trim().replace(/\r?\n/g, ' ');
  return { status: done.status, out };
}

/** Explorer 真正用的关联解析（`assoc` 只读 HKCR 默认值，常常是空的）。 */
const USER_CHOICE_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice';

export interface WindowsShellHandoffOptions {
  /** 关联查询命令（测试可注入假的）；默认走真实 `cmd /c`。 */
  readonly queryAssoc?: () => { readonly progId: string; readonly command: string; readonly raw: string };
  /** 打开命令（测试可注入假的）；默认 `cmd /c start "" <path>`。 */
  readonly openFile?: (path: string) => { readonly status: number | null; readonly out: string };
}

export function createWindowsShellPrintHandoff(
  options: WindowsShellHandoffOptions = {},
): PrintHandoffPort {
  const queryAssoc = options.queryAssoc ?? (() => {
    // 首选 Explorer 的 UserChoice（这才是双击 PDF 真正走的那条路）。
    const choice = cmd(['reg', 'query', USER_CHOICE_KEY, '/v', 'ProgId']);
    const matched = /ProgId\s+REG_SZ\s+(\S+)/.exec(choice.out);
    const choiceProgId = matched?.[1] ?? '';
    // 退路：HKCR 的 `assoc`（本机实测因 HKCR\.pdf 默认值为空而失败——所以它只能是退路）。
    const assoc = choiceProgId.length > 0
      ? { status: null, out: '(已由 UserChoice 解析，跳过)' }
      : cmd(['assoc', '.pdf']);
    const assocProgId = assoc.out.includes('=')
      ? assoc.out.split('=').slice(1).join('=').trim()
      : '';
    const progId = choiceProgId.length > 0 ? choiceProgId : assocProgId;
    const ftype = progId.length > 0
      ? cmd(['ftype', progId])
      : { status: null, out: '(无 ProgID，跳过 ftype)' };
    return {
      progId,
      command: ftype.out,
      raw: `reg query UserChoice /v ProgId -> rc=${String(choice.status)} ${choice.out}`
        + `\nassoc .pdf -> rc=${String(assoc.status)} ${assoc.out}`
        + `\nftype ${progId} -> rc=${String(ftype.status)} ${ftype.out}`,
    };
  });

  const openFile = options.openFile ?? ((path: string) => cmd(['start', '', path]));

  const platform: PrintHandoffPlatform = 'windows-desktop';

  return {
    platform,
    async open(targetPath: string): Promise<PrintHandoffOpenResult> {
      const assoc = queryAssoc();
      const opened = openFile(targetPath);
      const started = `start "" ${targetPath} -> rc=${String(opened.status)} ${opened.out}`;
      const accepted = opened.status === 0;
      const hasHandler = assoc.progId.length > 0;
      return {
        // 「已打开目标应用」要**两样**：shell 受理 + 系统里真的登记了处理器。
        // 只有其一（尤其只凭 `start` 的退出码）不足以说"已交接"——本机就踩过
        // `assoc .pdf` 失败却被 `start` rc=0 蒙混过去的情形。
        opened: accepted && hasHandler,
        handler: hasHandler ? `${assoc.progId} :: ${assoc.command}` : null,
        detail: accepted && hasHandler
          ? '系统已受理打开请求（已交接，不代表已打印）'
          : hasHandler
            ? `打开请求返回非零退出码 ${String(opened.status)}`
            : '系统里没有登记的 .pdf 处理器，**交接目标不存在**（rc=0 只代表 cmd 受理了请求）',
        raw: `${assoc.raw}\n${started}`,
      };
    },
  };
}

/**
 * **没有**打印交接通路的平台（Android / 其它）。
 *
 * 这个端口存在的意义是让"手机端打印未实现"变成一条**可断言的事实**，
 * 而不是一句口头声明。任何 `open()` 都返回 `opened:false`。
 */
export function createUnsupportedPrintHandoff(platform: PrintHandoffPlatform): PrintHandoffPort {
  return {
    platform,
    async open(targetPath: string): Promise<PrintHandoffOpenResult> {
      return {
        opened: false,
        handler: null,
        detail: `平台 ${platform} 上没有打印交接通路（未实现、未验证）`,
        raw: `platform=${platform} target=${targetPath} -> 无 PrintManager / 无 shell start 通路`,
      };
    },
  };
}
