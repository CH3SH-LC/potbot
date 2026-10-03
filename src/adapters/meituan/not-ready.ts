/**
 * 美团域的**就绪度报告**（MT-01–08，合同 R231 / R233）。
 *
 * 口径同 clock / calendar：`implemented` 只表示"**本批范围内、不依赖真实接口与账号**的部分
 * 已完成且有本机证据"。文本版（含来源链接）见 `outputs/FA-M/readiness-matrix.md`。
 *
 * ## 本批对美团只做**合同与不变量**（任务约定）
 *
 * 没有真实接口与账号时，任何"能查候选"的实现都只能是**编造**候选（MT-02 明令禁止）。
 * 因此本批把可静态保证的部分（七态、不购买、不编造、规则可解释）做成代码，
 * 把"接真实接口"如实登记为未就绪。
 */

import {
  LOCAL_VERIFIED,
  NOT_INSTALLED,
  assertReadinessRecord,
  type CapabilityState,
  type SubitemReadiness,
} from '../clock/readiness.js';

const EVIDENCE = ['src/adapters/meituan/meituan.test.ts', 'src/adapters/meituan/action-contract.test.ts'];

const CONTRACT_ONLY_CAPABILITY: CapabilityState = LOCAL_VERIFIED;

const MEITUAN_SUBITEM_LIST: readonly SubitemReadiness[] = [
  {
    id: 'MT-01',
    requirement: '接入已授权的真实接口/MCP/Skills 能力，登记工具、覆盖区域/业务、输入输出和限制；安装入口存在不算已接通',
    verdict: 'not_ready',
    implementedScope:
      '工具声明（R241 全字段）已按既有 capability_id 落地：cap.meituan.search/detail/handoff 的输入输出 schema、' +
      '权限、副作用、是否需确认、幂等/查询/撤销、可信回执。',
    reason:
      '**没有真实接口与账号**：未登录、未获取工具清单、未执行任何调用。' +
      '已核实的事实：美团公开入口确实列出 MCP/Skills（入口为 developer.meituan.com/ai-hub，非 /docs），' +
      '但调用需实名/资质获取 Token——「可看」不等于「可用」，故不接通。',
    unblockedBy: '用户提供已授权账号与 token（或门店授权），并给出工具清单；随后接入 AuthorizedMeituanSearchPort。',
    capability: NOT_INSTALLED,
    evidence: ['src/adapters/meituan/contract.ts'],
  },
  {
    id: 'MT-02',
    requirement: '按品类/位置/人数/预算/日期/偏好查询实际可得候选；查询条件和结果范围可见，不能用模型编候选',
    verdict: 'not_ready',
    implementedScope:
      '「**不编造候选**」做成**结构性**保证：候选唯一来源是已授权接口或用户分享，每条必带非空来源；' +
      '端口未接通时 status=not_ready 且**候选恒为空**；查询条件/缺失条件可见（describeVisibility）。',
    reason: '真实查询需要已授权接口；无接口时按 MT-02 拒绝产出候选，故本子项停在未就绪。',
    unblockedBy: '同 MT-01：接通 AuthorizedMeituanSearchPort。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/meituan/candidates.ts', ...EVIDENCE],
  },
  {
    id: 'MT-03',
    requirement: '读取可得详情、套餐/费用条件、时效与来源；价格/库存/营业/路线未知分别标记，不能把标价当最终价',
    verdict: 'not_ready',
    implementedScope:
      '数据模型已实现：价格/库存/营业/路线各自 KnownValue（未知必带原因）；' +
      '`isFinalPrice` 为字面量 false，使"把标价当最终价"在类型层面不成立。真实读取详情未接通。',
    reason: '详情读取需要已授权接口；当前无接口与账号。',
    unblockedBy: '同 MT-01。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/meituan/candidates.ts'],
  },
  {
    id: 'MT-04',
    requirement: '按用户分享的文本/链接/图片或文件补充候选，与在线来源分开标识；只比较几个候选时不宣称全平台最优',
    verdict: 'not_ready',
    implementedScope:
      '「与在线来源分开标识」已实现（partitionBySource + sourceKind）；' +
      '"只比较几个候选不宣称最优"已写进可见性说明。',
    reason:
      '从**图片/文件**抽取候选内容需要 OCR / 文档解析通道，本轮未接通；' +
      '本批只接受已结构化的用户分享条目。',
    unblockedBy: '接通 OCR/文档解析（同 FA-G2 的 research_ocr 未就绪项），或用户直接提供文本。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/meituan/candidates.ts（candidatesFromUserShare / partitionBySource）'],
  },
  {
    id: 'MT-05',
    requirement: '可解释筛选、比较、排序、硬条件冲突和缺资料处理；用户修改条件可重算，资料中的宣传话术不改变用户规则',
    verdict: 'implemented',
    implementedScope:
      '硬条件筛选 + 软规则排序（均**只读结构化字段**）；每条淘汰都给原因；硬条件把候选筛空时给出冲突说明；' +
      '未知值排在最后且**不当作 0**。宣传话术在 RawCandidate 归一为 Candidate 时被丢弃，**结构上无法**参与规则。',
    reason: null,
    unblockedBy: '',
    capability: CONTRACT_ONLY_CAPABILITY,
    evidence: ['src/adapters/meituan/candidates.ts（applyRules / rankCandidates）', ...EVIDENCE],
  },
  {
    id: 'MT-06',
    requirement: '将获准事实交给预算、文档、演示等模板，保留来源和时间，不让下游另猜价格',
    verdict: 'not_ready',
    implementedScope:
      '可发布事实结构已实现（key/value/sourceRef/sourceKind/observedAtMs/kind=fact），保留来源与时间。',
    reason:
      '**未接任何下游模板**：预算/文档/演示的接线由其他领域包与总协调持有，不在本包写权内；' +
      '未接下游前**不宣称**已在其他模板生效。',
    unblockedBy: '总协调定义事实落位并把 exportCandidateFacts 的输出接到预算/文档/演示模板。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true, deps_ready: true },
    evidence: ['src/adapters/meituan/candidates.ts（exportCandidateFacts）'],
  },
  {
    id: 'MT-07',
    requirement: '生成并验证目标页面交接，参数与当前选择绑定；链接来自受控适配器或已核实来源，App 未安装/链接过期/目标不符分别处理',
    verdict: 'not_ready',
    implementedScope:
      '交接前校验与四种**分别处理**的失败分类已实现（app_not_installed / link_expired / target_mismatch / ' +
      'stale_selection），且参数与选择版本绑定（过期即拒绝）。',
    reason:
      '「链接来自受控适配器或已核实来源」需要一个真实的、可核实的链接来源；本批无接口、无账号，' +
      '无法生成受控链接，故不产出任何交接目标。',
    unblockedBy: '同 MT-01：接通已授权接口以获得受控链接。',
    capability: { ...NOT_INSTALLED, installed: true, enabled: true },
    evidence: ['src/adapters/meituan/handoff.ts'],
  },
  {
    id: 'MT-08',
    requirement: '气泡过期、重复点击、返回和用户报告结果正确处理；不直接购买/支付；外部最终结果无法读取时保留未知，不把交接记为购买成功',
    verdict: 'implemented',
    implementedScope:
      '七态结算路径已实现：交接最高只到「已交接」；外部结果不可读 ⇒ 「结果未知」（不记为购买成功、不盲目重试）；' +
      '用户口述 ⇒ 「用户报告完成」（不升级为系统确认）；外部废止 ⇒ 只能以 expired 失效。' +
      '「不直接购买/支付」由工具声明校验与 assertNotPurchaseAction 双重拦截。',
    reason: null,
    unblockedBy: '',
    capability: CONTRACT_ONLY_CAPABILITY,
    evidence: [
      'src/adapters/meituan/handoff.ts',
      'src/adapters/meituan/contract.ts（assertNotPurchaseAction / validateMeituanTools）',
      ...EVIDENCE,
    ],
  },
];

for (const record of MEITUAN_SUBITEM_LIST) assertReadinessRecord(record);

export const MEITUAN_SUBITEMS: readonly SubitemReadiness[] = Object.freeze(MEITUAN_SUBITEM_LIST);

export interface MeituanNotReadyCapability {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly state: CapabilityState;
  readonly verdict: 'not_ready' | 'blocked';
  readonly reason: string;
  readonly unblockedBy: string;
}

export const MEITUAN_NOT_READY: readonly MeituanNotReadyCapability[] = Object.freeze([
  {
    id: 'meituan_mcp',
    requirements: ['MT-01', 'MT-02', 'MT-03', 'MT-07'],
    state: NOT_INSTALLED,
    verdict: 'not_ready',
    reason:
      '未接通已授权的美团接口/MCP/Skills：未登录、无 token、无工具清单。' +
      '公开入口（developer.meituan.com/ai-hub）确实列出 MCP 与 Skill 条目，但**需实名/资质换取 Token 后才能调用**。',
    unblockedBy: '用户提供已授权账号/token 与工具清单。',
  },
  {
    id: 'meituan_user_share_extract',
    requirements: ['MT-04'],
    state: NOT_INSTALLED,
    verdict: 'not_ready',
    reason: '从图片/文件中抽取候选内容需要 OCR 与文档解析通道，本轮未接通。',
    unblockedBy: '接通 OCR / 文档解析（与 FA-G2 的 research_ocr 同一依赖）。',
  },
  {
    id: 'meituan_purchase_channel',
    requirements: ['MT-08'],
    state: NOT_INSTALLED,
    verdict: 'blocked',
    reason:
      '**合同层面禁止**：MT-08 / R246 明确「不直接购买/支付」。这不是"以后做"，而是**永久不做的约束**——' +
      '系统不得提供任何支付/下单通道，只能交接页面并由用户在 App 内完成。',
    unblockedBy: '无（合同禁止）。若将来用户撤销该约束，须先修订合同并重新设计授权与回执链。',
  },
]);

export function meituanReadinessReport(): {
  readonly subitems: readonly SubitemReadiness[];
  readonly capabilities: readonly MeituanNotReadyCapability[];
} {
  return { subitems: MEITUAN_SUBITEMS, capabilities: MEITUAN_NOT_READY };
}
