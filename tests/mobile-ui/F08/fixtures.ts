/**
 * F08 测试夹具：一个**显式标注 fixture 模式**的模版目录状态，覆盖四态的各种并存组合。
 *
 * 这不是产品成功证据——`verificationMode: 'fixture'` 全程保留；它的唯一目的是让四态
 * 独立性、能力不足可见、更新/回滚这些**断言**有确定的输入。
 */

import {
  authorizeTemplate,
  createTemplatesState,
  enableTemplate,
  installTemplate,
  recordProbe,
  type TemplatesState,
} from '../../../apps/mobile-ui/src/templates/index.js';

/** 构造覆盖四态各类并存的夹具状态。 */
export function fixtureState(): TemplatesState {
  let state = createTemplatesState();

  // 文档：四态全绿（已安装 / 已启用 / 已授权 / 端口就绪）。
  state = installTemplate(state, 'template.document', '1.0.0');
  state = authorizeTemplate(state, 'template.document', ['storage', 'file-write', 'model']);
  state = enableTemplate(state, 'template.document');
  state = recordProbe(state, 'template.document', { portReady: true, checkedAt: '2026-10-03T08:00:00Z' });

  // 表格：已安装 / 已启用 / 已授权，但**端口未就绪**（内核端口没接上）。
  state = installTemplate(state, 'template.spreadsheet', '1.0.0');
  state = authorizeTemplate(state, 'template.spreadsheet', ['storage', 'file-write', 'model']);
  state = enableTemplate(state, 'template.spreadsheet');
  state = recordProbe(state, 'template.spreadsheet', {
    portReady: false,
    portReason: '内核端口未接通（K06 probe）',
  });

  // 演示：已安装 / 已启用 / **未授权**（缺 model），端口就绪。
  state = installTemplate(state, 'template.presentation', '1.0.0');
  state = enableTemplate(state, 'template.presentation');
  state = recordProbe(state, 'template.presentation', { portReady: true });

  // 美团：已安装 / 已启用 / 已授权，但端口未就绪 + 依赖缺失 + 能力不支持。
  state = installTemplate(state, 'template.meituan', '1.0.0');
  state = authorizeTemplate(state, 'template.meituan', ['network', 'model', 'external-order']);
  state = enableTemplate(state, 'template.meituan');
  state = recordProbe(state, 'template.meituan', {
    portReady: false,
    portReason: '美团接口未接通（未授权源）',
    missingDependencies: ['已授权的美团接口 / MCP'],
    unsupportedCapabilities: ['cap.meituan.search'],
  });

  // 时钟：**未安装**。
  // 日历：未安装，但**端口就绪**（探针独立于安装态）——反向对照。
  state = recordProbe(state, 'template.calendar', { portReady: true });

  // 资料检索：已安装 / 未启用 / 未授权。
  state = installTemplate(state, 'template.research', '1.0.0');

  return state;
}
