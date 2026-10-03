/**
 * 未就绪能力登记（合同 **R231 / R233**：能力发现区分五态，未就绪先给原因）。
 *
 * 标识符**沿用** `src/plugins/catalog.ts` 冻结的既有命名（`cap.research.*`、
 * `research_network_port`、`research_ocr`、`template.meituan` 等），
 * **不新造平行命名**——本文件只提供"可读取的未就绪清单"，不改插件目录。
 *
 * 文本版（给人看、含实测命令与输出）见 `outputs/FA-G2/not-ready-reasons.md`。
 */

/** R231 的五个状态维度。 */
export interface CapabilityState {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly deps_ready: boolean;
  /** 是否**实测**支持过（有真实入口跑通的证据）。 */
  readonly verified_supported: boolean;
}

export interface NotReadyItem {
  readonly id: string;
  /** 对应需求编号（能力目录）。 */
  readonly requirements: readonly string[];
  readonly state: CapabilityState;
  /** 未就绪原因（未就绪时必填）。 */
  readonly reason: string | null;
}

const NOT_READY_DEPS: CapabilityState = {
  installed: false,
  enabled: false,
  authorized: false,
  deps_ready: false,
  verified_supported: false,
};

/** 本切片**实测支持**的部分（私有资料纵切片）。 */
export const LOCAL_CORPUS_CAPABILITY: NotReadyItem = {
  id: 'cap.research.extract#local_docs',
  requirements: ['RES-03', 'RES-04', 'RES-05', 'RES-09', 'RES-10'],
  state: {
    installed: true,
    enabled: true,
    authorized: true,
    deps_ready: true,
    verified_supported: true,
  },
  reason: null,
};

/** 全部未就绪项（逐条给原因；顺序即展示顺序）。 */
export const NOT_READY: readonly NotReadyItem[] = Object.freeze([
  {
    id: 'research_network_port',
    requirements: ['RES-01', 'RES-02', 'RES-06', 'RES-08'],
    state: NOT_READY_DEPS,
    reason:
      '本机无真实查询端口：环境变量中无任何检索/搜索服务凭据；仅有模型路由器 127.0.0.1:8008，' +
      '它不是查询端口。用它作答等于"以模型已有知识冒充联网检索"，RES-01 明文禁止，故不接通。',
  },
  {
    id: 'cap.research.query',
    requirements: ['RES-01', 'RES-02', 'RES-08'],
    state: NOT_READY_DEPS,
    reason: '依赖 research_network_port，未接通。',
  },
  {
    id: 'research_ocr',
    requirements: ['RES-03'],
    state: NOT_READY_DEPS,
    reason:
      '本机无 OCR 引擎（tesseract / ocrmypdf 均不在 PATH）。扫描件/图片返回 "ocr-required" 并说明原因，' +
      '绝不以文件名或模型知识编造内容。宿主侧另有本地视觉工具，但不在产品运行链上，不作为已接通证据。',
  },
  {
    id: 'cap.research.extract#office_xlsx_pptx',
    requirements: ['RES-03'],
    state: { ...NOT_READY_DEPS, installed: true, enabled: true },
    reason:
      '本次增量只接通 TXT/Markdown/PDF/DOCX；XLSX/PPTX 解析未接通（插件清单声明可读，但本增量未实现）。',
  },
  {
    id: 'cap.research.publish',
    requirements: ['RES-07'],
    state: { ...NOT_READY_DEPS, installed: true, enabled: true, deps_ready: true },
    reason:
      '本切片能产出带版本/来源/片段锚点的可发布事实结构，但**未接任何下游模板**；' +
      '"不复用网页指令当授权"属授权链路，归总协调的协议层，本切片未涉及。未接下游前不宣称已发布。',
  },
  {
    id: 'template.meituan',
    requirements: ['MT-01', 'MT-02', 'MT-04', 'MT-06'],
    state: NOT_READY_DEPS,
    reason: '无美团真实接口/账号：未登录、未获取工具清单。无真实接口只能编候选，违反 MT-04，故不实现。',
  },
  {
    id: 'template.clock',
    requirements: ['CLK-01', 'CLK-05', 'CLK-06', 'CLK-08'],
    state: NOT_READY_DEPS,
    reason: '缺设备与系统权限核实：真机未连接，精确提醒/通知权限与厂商闹钟读回接口均未核实。',
  },
  {
    id: 'template.calendar',
    requirements: ['CAL-01', 'CAL-07', 'CAL-09', 'CAL-10'],
    state: NOT_READY_DEPS,
    reason: '缺设备与日历系统权限：授权直写与"打开系统编辑页"的区分必须在真机读回，当前无设备。',
  },
]);

/** 供产品做"能力发现"读取的清单。 */
export function capabilityReport(): readonly NotReadyItem[] {
  return [LOCAL_CORPUS_CAPABILITY, ...NOT_READY];
}
