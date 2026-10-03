/**
 * FA-Q —— 结构性 / 呈现性 / 恢复**前置**清单（H0 要求 Q 去做的事）
 *
 * 只读排查：**当前实现会在哪里失败**。每条给 `file:line` + 现象 + 最小复现思路 + 复现命令。
 *
 * ⚠️ 观察时间与移动靶：本清单核对于 **2026-10-03 05:16 (+08:00)**。当时
 * `src/storage/**`、`src/scheduler/**`、`src/documents/session/**` 正被并发流 FA-B 编辑
 * （`file-store.ts` 就是在我复核**前一分钟**落地的）。因此每条都带 `verified`：
 *   - 'reverified'：我在观察时刻**亲自重跑命令**确认过；
 *   - 'sweep_only'：来自只读扫描报告，未在观察时刻重跑（可能已被并发改动越过）。
 * **引用前必须按 `repro` 重新核对**——本仓库正处多流并发。
 *
 * 本文件是**纯数据**，不 import 任何产品实现（产品树在动，套件必须保持稳定）。
 */

export const PREREQ_CATEGORIES = [
  'cross_process_recovery', // 跨进程/重启恢复
  'id_continuity', // ID 连续性
  'clock_continuity', // 时钟/租约/预算连续性
  'trusted_identity', // 可信身份重建
  'stale_bubble', // 旧气泡失效
  'permission_revocation', // 权限撤销
  'data_mismatch', // 数据错配（事实变更不传播）
  'presentational', // 呈现性（固定样例冒充完整模板）
  'state_taxonomy', // 状态七态
  'phone_background', // 手机后台/进程回收
] as const;
export type PrereqCategory = (typeof PREREQ_CATEGORIES)[number];

export type VerifiedState = 'reverified' | 'sweep_only';

export interface StructuralPrereq {
  readonly id: string;
  readonly category: PrereqCategory;
  /** 违反的合同条款 */
  readonly contract_refs: readonly string[];
  /** 精确位置 path:line */
  readonly location: string;
  readonly quote: string;
  /** 现象：一句话 */
  readonly symptom: string;
  /** 最小复现思路（不需真机 / 不需 live 服务） */
  readonly repro_idea: string;
  /** 可直接执行的复现命令（bash）：预期结果写在命令里 */
  readonly repro_command: string;
  /** 会阻塞哪些 A 项 / 目录项 */
  readonly blocks: readonly string[];
  readonly verified: VerifiedState;
}

export const OBSERVED_AT = '2026-10-03T05:16+08:00';

export const STRUCTURAL_PREREQS: readonly StructuralPrereq[] = [
  {
    id: 'F1',
    category: 'id_continuity',
    contract_refs: ['R202', 'R216'],
    location: 'src/protocol/ids.ts:166',
    quote: 'export function createIdSource(...) { const counters = new Map<string, number>(); ... }',
    symptom:
      '每调用一次 createIdSource 就新建一套计数器（从 0 起）；两个进程或一次重启后都会产出相同的 msg-1 / req-1 / run-1 / evt-1，ID 不跨进程唯一。',
    repro_idea:
      '两个独立 createIdSource() 各取首个 messageId，断言二者相等（当前必相等）。消费入口：src/scheduler/scheduler.ts:184、apps/demo/server/kernel.ts:1106、apps/demo/server/session-host.ts:226 均无种子。',
    repro_command:
      "grep -n 'const counters = new Map' src/protocol/ids.ts && grep -n 'createIdSource()' src/scheduler/scheduler.ts apps/demo/server/kernel.ts apps/demo/server/session-host.ts",
    blocks: ['A10', 'A04', 'KRN-10', 'R202', 'R216'],
    verified: 'reverified',
  },
  {
    id: 'F2',
    category: 'clock_continuity',
    contract_refs: ['R203', 'R216', 'R225'],
    location: 'src/clock/logical-clock.ts:81',
    quote: 'constructor(initialTime: LogicalTime = asLogicalTime(LOGICAL_TIME_ORIGIN))',
    symptom:
      '逻辑时钟默认从原点 0 起，且宿主每次启动都 new LogicalClock()；租约 deadline 由该时钟派生并只活在易失 state 里——重启后租约与运行预算“复活”（新的 run 又拿到满额）。',
    repro_idea:
      '跑一次 startRun 观察 lease_deadline 与 budgetUsage().runs，再用一个新 LogicalClock/新 store，断言其为 0（当前必为 0，即无连续性）。另：宿主 createScheduler 未接预算（scheduler.ts:193 的 #budgetProjection 为 null）。',
    repro_command:
      "grep -n 'new LogicalClock()' apps/demo/server/kernel.ts apps/demo/server/session-host.ts && grep -n 'createRunLease' src/scheduler/runs.ts | head -2",
    blocks: ['A19', 'A10', 'KRN-12', 'R203', 'R225'],
    verified: 'reverified',
  },
  {
    id: 'F3',
    category: 'trusted_identity',
    contract_refs: ['R204', 'R216'],
    location: 'src/protocol/message.ts:101',
    quote: 'const KERNEL_ISSUED_BINDINGS = new WeakSet<object>();',
    symptom:
      '可信发送者绑定是**进程私有 WeakSet**。重启后从持久记录解码出来的消息，其 sender_binding 是普通冻结对象、永远不在 WeakSet 里 ⇒ 入口闸门永久拒绝；且**没有**任何“按持久记录 + 当前授权重新签发”的重建入口。',
    repro_idea:
      'JSON 反序列化一条消息并断言 isKernelIssuedBinding(...) === false（这是**正确**的一半），再 grep 任何把持久 {sender_instance_id, group_id} 重新签发的函数——不存在（这是**缺失**的一半）。',
    repro_command:
      "grep -rn 'KERNEL_ISSUED_BINDINGS' src/protocol/message.ts && grep -rniE 'rebuild.*[Bb]inding|reauth|重新签发' src/ apps/ --include=*.ts | grep -v test || echo 'NO REBUILD PATH'",
    blocks: ['A10', 'A09', 'R204', 'R216'],
    verified: 'reverified',
  },
  {
    id: 'F4',
    category: 'cross_process_recovery',
    contract_refs: ['R215', 'R216', 'R220'],
    location: 'apps/demo/server/main.ts:674',
    quote: 'const store = createKernelStore(paths);  … new KernelHost({ jobs, store, … })',
    symptom:
      '（**已于 2026-10-03 10:52 复核后改写**）生产路径 `main.ts` 现把**落盘 store**（`createFileStore`，含跨进程锁；读不回即**拒绝启动**）注入 `KernelHost`（main.ts:35/416/674）。**仍存的两点**：(a) `apps/demo/server/session-host.ts:254` 依旧 `createMemoryStore`（文档会话宿主易失）；(b) 更关键——**有持久 store ≠ 重启后可恢复**：`src/protocol/ids.ts` 计数器每进程重置（F1）、无 `SenderBinding` 重建入口（F3），故恢复链仍不完整。',
    repro_idea:
      '分别静态核对：main.ts 注入 file-store；session-host.ts 仍内存；再把 F1/F3 一并看——三者同属 R216 的一条链，缺一即不可宣称"重启后恢复"。',
    repro_command:
      "grep -n 'createFileStore\\|createMemoryStore\\|createKernelStore' apps/demo/server/main.ts apps/demo/server/session-host.ts apps/demo/server/kernel.ts",
    blocks: ['A10', 'KRN-10', 'R215', 'R216', 'R220'],
    verified: 'reverified',
  },
  {
    id: 'F5',
    category: 'stale_bubble',
    contract_refs: ['R212', 'R213'],
    location: 'apps/demo/web/app.js:1279',
    quote: "op = bridgeOps.begin({ documentId: ..., revision: Number(artifact.taskRevision), ... });  // 记录 revision",
    symptom:
      '气泡（产物面板动作）在 begin 时**记下** revision，但**没有任何代码把它与当前 revision 比较**再执行；基于旧版本的“保存/打开”照样发出。R212 的“过期点击各有正确状态”、R213 的“旧气泡过期”无处落地。',
    repro_idea:
      'grep 前端 `op.revision` 的使用点：只有只读导出用得到，执行路径不比较。或在浏览器里打开产物面板 → 服务端发布新版本 → 再点保存，观察旧 op 仍发出。',
    repro_command:
      "grep -n 'op\\.revision' apps/demo/web/*.js ; grep -nE 'revision\\s*[!=]==?' apps/demo/web/app.js || echo 'NO REVISION COMPARISON'",
    blocks: ['A07', 'A15', 'R212', 'R213'],
    verified: 'reverified',
  },
  {
    id: 'F6',
    category: 'permission_revocation',
    contract_refs: ['R244', 'R205', 'R245'],
    location: 'src/protocol/task.ts:43',
    quote: 'authorized_data_refs: readonly ... （声明并往返，但全仓无消费者）',
    symptom:
      '**没有权限子系统**：没有对象携带权限、没有在调用点读权限、没有可撤销的授权记录、没有委派链。`authorized_data_refs` 是死字段。因此“每次调用检查权限”“运行中撤权即时生效”“委派不提高权限”三条都没有对应代码。',
    repro_idea: "grep 除 task.ts 外的 authorized_data_refs 消费者 → 空；grep 撤权相关实现 → 只命中文档编辑的 undo。",
    repro_command:
      "grep -rn 'authorized_data_refs' src apps --include=*.ts | grep -v 'task.ts' || echo 'NO CONSUMER (unused field)'",
    blocks: ['A14', 'A18', 'A06', 'R244', 'R205'],
    verified: 'sweep_only',
  },
  {
    id: 'F7',
    category: 'data_mismatch',
    contract_refs: ['R248', 'R251', 'R213'],
    location: 'src/artifacts/publish.ts:427',
    quote: 'else if (currentRevision !== record.task_revision) { ... version_stale ... }',
    symptom:
      '版本闸门**只比 task_revision**，不比事实身份。事实可在**同一 revision 内**被 supersede（facts.ts:116 的 supersedes 就是同任务+版本+键），于是携带旧事实的产物仍通过闸门、发布旧值。且全仓**没有 fact→artifact 反查索引**：staging.ts 只**写** source_fact_refs，从不据此找出受影响产物。',
    repro_idea:
      '同 revision：先 stage（快照含 headcount=8）→ 写入 supersedes 的 headcount=10 → 触发发布投影；闸门放行、发布 8。',
    repro_command:
      "grep -n 'currentRevision !== record.task_revision' src/artifacts/publish.ts && grep -rn 'byFact\\|fact_index\\|indexByFact' src/artifacts src/facts --include=*.ts || echo 'NO FACT->ARTIFACT INDEX'",
    blocks: ['A07', 'A08', 'A13', 'A16', 'XLS-18', 'PPT-16', 'R248', 'R251'],
    verified: 'reverified',
  },
  {
    id: 'F8',
    category: 'presentational',
    contract_refs: ['R250', 'R249'],
    location: 'src/artifacts/templates/pptx.ts:544',
    quote: 'const slides: readonly (readonly TextBoxSpec[])[] = [ ...2 个固定 slide... ]',
    symptom:
      '（**2026-10-03 10:52 复核后补注**）**产品入口已通**：XLSX/PPTX 现经内核链交付（FA-T 09:22、FA-U 10:26，独立读回）。**但模板本体仍是固定形状**：PPTX 恒 2 页（无页数输入字段，`pptx.ts:544` 仍 `const slides=[…2…]`）；XLSX 恒单张两列“分项/合计”表（`xlsx.ts:90` 单 `sheet1.xml`）、只写结果值不写公式（无 `<f>`）；DOCX 是固定极简骨架。**没有** XLSX/PPTX 导入/读回模块，故“原件与未知部件保留”对表格/演示完全未实现。**"产品入口可达" ≠ "模板具备完整操作"**——不得据此判 XLS-02/XLS-06/PPT-01 通过。',
    repro_idea:
      '任意 buildPresentation(...) 后解包数 ppt/slides/slide*.xml → 恒为 2；任意 buildXlsxTemplate 后 grep <f> → 0 命中；给真实 .xlsx 字节 → 无任何 API 可读回。',
    repro_command:
      "grep -n 'const slides' src/artifacts/templates/pptx.ts && grep -n 'XLSX_WORKSHEET_PART_PATH' src/artifacts/templates/xlsx.ts && grep -rn \"el('f'\" src/artifacts/templates/xlsx.ts || echo 'NO FORMULA ELEMENT'",
    blocks: ['A01', 'PPT-01', 'PPT-03', 'XLS-01', 'XLS-02', 'XLS-06', 'R249', 'R250'],
    verified: 'reverified',
  },
  {
    id: 'F9',
    category: 'state_taxonomy',
    contract_refs: ['R242', 'R209'],
    location: 'src/protocol/artifact.ts:68',
    quote: "export const ARTIFACT_STATUSES = ['staged','published','failed','superseded','expired'] as const;",
    symptom:
      'R242 的七态**不是一个枚举**，而是散在四处更窄的枚举里（artifact/constants/contracts/Android 打印态）。“已提交”“结果未知”“用户报告完成”没有一等状态；“expired” 声明但**全仓无生产者**（死枚举）。消息本身**无状态字段**，R209 的“发送中”“取消”不存在。',
    repro_idea:
      '断言 ARTIFACT_STATUSES 是否含七态全部 → 否（只有 5 项且命名不对应）；断言 TaskStatus 不含 sending/cancelled；断言 http.ts 无 /cancel 路由。',
    repro_command:
      "grep -n 'ARTIFACT_STATUSES' src/protocol/artifact.ts && grep -rn \"'expired'\" src --include=*.ts | grep -v 'artifact' || echo 'expired HAS NO PRODUCTION PRODUCER'",
    blocks: ['A09', 'A11', 'A19', 'R242', 'R209'],
    verified: 'reverified',
  },
  {
    id: 'F10',
    category: 'phone_background',
    contract_refs: ['R255', 'R256', 'R257', 'R253'],
    location: 'apps/android/app/src/main/AndroidManifest.xml:15',
    quote: '<activity ...>（单一 Activity；无 <service>、无 <receiver>）',
    symptom:
      '手机层后台**完全缺席**：无 Service / WorkManager / BroadcastReceiver / 通知；MainActivity 无 onPause/onStop，只有随进程死亡的守护线程；进程回收后除 Bundle 恢复外无机制，且 App 关闭后无法获知进度。也没有任何取消通道。',
    repro_idea:
      "静态 grep 后台设施 → 空（build/ 里的 notification_* 是 androidx.core 库资源，不是应用代码）。APK **存在**：apps/android/app/build/outputs/apk/debug/app-debug.apk（1,315,455 B）——但“APK 存在”≠“已装机验证”。",
    repro_command:
      "grep -rn 'Service\\|WorkManager\\|startForeground\\|Notification' apps/android/app/src/main | grep -v build || echo 'NO BACKGROUND MACHINERY' ; ls -l apps/android/app/build/outputs/apk/debug/app-debug.apk",
    blocks: ['APP-05', 'APP-06', 'A09', 'A10', 'R255', 'R256', 'R257'],
    verified: 'reverified',
  },
];
