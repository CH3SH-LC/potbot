/**
 * FA-VERIFY-WAVE-8 · **派发图**：把「哪个 `/api/**` 前缀由谁派发」写成可核对的数据。
 *
 * 前缀常量**直接 import 自各路由模块**（不抄字面量），因此模块改了根路径，这张表会跟着变、
 * 不会被"抄一份字面量"糊过去；`via` 是 `http.ts` 里**必须出现**的派发标识符（调用点）。
 *
 * 每个单元还要能通过 `probe` 在真服务上打一发（见 T3）。
 */

import { ADAPTERS_ROOT } from '../../../apps/demo/server/adapters-host.js';
import { ACTIONS_ROOT } from '../../../apps/demo/server/adapters-actions.js';
import { EXTRA_ADAPTERS_ROOT } from '../../../apps/demo/server/adapters-extra-routes.js';
import { DOCUMENTS_ROOT } from '../../../apps/demo/server/documents-routes.js';
import { FACTS_ROOT } from '../../../apps/demo/server/facts-routes.js';
import { MEMORY_ROOT } from '../../../apps/demo/server/memory-routes.js';
import { PLUGINS_ROOT } from '../../../apps/demo/server/plugin-routes.js';
import { PPT_FACTS_ROOT } from '../../../apps/demo/server/ppt-facts-product.js';
import { RESEARCH_ROOT } from '../../../apps/demo/server/research-routes.js';
import { CONVERSATION_LOOP_ROOT } from '../../../apps/demo/server/route-wiring.js';
import { ROLES_ROOT } from '../../../apps/demo/server/roles-wiring.js';
import { XLS_FACTS_ROOT } from '../../../apps/demo/server/xls-facts-product.js';
import { TOOL_LOOP_ROOT } from '../../../apps/demo/server/tool-loop-product.js';

/** 一个路由单元：前缀 + `http.ts` 里必须存在的派发标识符（或调用的接收者名）。 */
export interface RouteUnit {
  readonly root: string;
  /** 负责该前缀的模块（相对 `apps/demo/server/`）。 */
  readonly module: string;
  /** `http.ts` 里必须出现的派发**调用**标识符（`name(`）或接收者属性（`recv.handle(`）。 */
  readonly via: string;
  /** `via` 是属性调用（`x.handle(...)`）时为真。 */
  readonly viaReceiver?: boolean;
}

/** 由独立路由模块承担的前缀（=http.ts 只按前缀转交的那些）。 */
export const DELEGATED_ROUTES: readonly RouteUnit[] = Object.freeze([
  { root: ADAPTERS_ROOT, module: 'adapters-host.ts', via: 'adapters', viaReceiver: true },
  { root: ACTIONS_ROOT, module: 'adapters-host.ts', via: 'adapters', viaReceiver: true },
  { root: EXTRA_ADAPTERS_ROOT, module: 'adapters-host.ts', via: 'adapters', viaReceiver: true },
  { root: MEMORY_ROOT, module: 'memory-routes.ts', via: 'handleMemoryRequest' },
  { root: PLUGINS_ROOT, module: 'plugin-routes.ts', via: 'handlePluginRequest' },
  { root: CONVERSATION_LOOP_ROOT, module: 'route-wiring.ts', via: 'loopRoutes', viaReceiver: true },
  { root: DOCUMENTS_ROOT, module: 'documents-routes.ts', via: 'handleDocumentsRequest' },
  { root: FACTS_ROOT, module: 'facts-routes.ts', via: 'handleFactsRequest' },
  { root: RESEARCH_ROOT, module: 'research-routes.ts', via: 'handleResearchRequest' },
  { root: PPT_FACTS_ROOT, module: 'ppt-facts-product.ts', via: 'handlePptxFactsRequest' },
  { root: ROLES_ROOT, module: 'roles-wiring.ts', via: 'rolesWiring', viaReceiver: true },
  { root: XLS_FACTS_ROOT, module: 'xls-facts-product.ts', via: 'handleXlsFactsRequest' },
  { root: TOOL_LOOP_ROOT, module: 'tool-loop-product.ts', via: 'handleToolLoopRequest' },
]);

/** `http.ts` 自己实现（不转交）的前缀：源里必须出现这些字面量，且真服务要能答。 */
export const OWN_ROUTES: readonly { readonly root: string; readonly literal: string; readonly probe: string }[] =
  Object.freeze([
    { root: '/health', literal: 'ROUTES.health', probe: '/' }, // 上面单独用 '/health'
    { root: '/api/identity', literal: "'/api/identity'", probe: '/api/identity' },
    { root: '/api/conversations', literal: 'CONVERSATIONS_ROOT', probe: '/api/conversations' },
    { root: '/api/tasks', literal: "'/api/tasks/'", probe: '/api/tasks/T-probe' },
    { root: '/api/artifacts', literal: "'/api/artifacts/'", probe: '/api/artifacts/A-probe/download' },
    { root: '/api/sessions', literal: "'/api/sessions/'", probe: '/api/sessions/S-probe' },
    { root: '/api/deliverables', literal: "'/api/deliverables'", probe: '/api/deliverables/D-probe' },
  ]);

/** `http.ts` 兜底 404 的形状——**任何已知前缀都不该落到这里**。 */
export const CATCH_ALL_404 = Object.freeze({ code: 'not_found', message: '没有这个接口' });

export function isCatchAll404(body: Record<string, unknown>): boolean {
  return body['code'] === CATCH_ALL_404.code && body['message'] === CATCH_ALL_404.message;
}
