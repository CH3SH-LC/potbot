import { describe, expect, it } from 'vitest';

import {
  asCapabilityId,
  asGroupId,
  asInstanceId,
  asMessageId,
  asRevision,
  asTaskId,
  createIdSource,
  createMessage,
  isKernelIssuedBinding,
  SenderBinding,
  type GroupMessage,
  type MessageDraft,
} from './index.js';

import { ValidationError } from './errors.js';

const TASK = asTaskId('T1');
const OTHER_TASK = asTaskId('T2');
const GROUP = asGroupId('G1');
const OTHER_GROUP = asGroupId('G2');
const SENDER = asInstanceId('S1');
const RECEIVER = asInstanceId('C');
const REV1 = asRevision(1);

const idSource = createIdSource({ seed: 'unit' });
/** 内核签发绑定的唯一公开入口（R35.2）。 */
const binding = SenderBinding.bind(SENDER, { group_id: GROUP, task_id: TASK });

const baseDraft: MessageDraft = {
  task_id: TASK,
  group_id: GROUP,
  task_revision: REV1,
  recipient_instance_id: RECEIVER,
  type: 'work_request',
  requires_wakeup: true,
};

describe('SenderBinding 签发与 isKernelIssuedBinding（F07 / R35.2）', () => {
  it('经 bind() 签发的绑定通过三合一判据，且字段齐全、实例已冻结', () => {
    expect(isKernelIssuedBinding(binding)).toBe(true);
    expect(binding.sender_instance_id).toBe(SENDER);
    expect(binding.group_id).toBe(GROUP);
    expect(binding.task_id).toBe(TASK);
    expect(binding.bound_by_kernel).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('冻结实例不可被改写：Object.assign 抛错，原绑定与判据不受影响', () => {
    const target = binding as unknown as { sender_instance_id: unknown };
    // ESM 即严格模式：对冻结属性赋值直接抛 TypeError，而不是静默失败。
    expect(() =>
      Object.assign(target, { sender_instance_id: asInstanceId('FORGED') }),
    ).toThrow(TypeError);
    expect(() => {
      (binding as unknown as { sender_instance_id: unknown }).sender_instance_id = SENDER;
    }).toThrow(TypeError);
    expect(binding.sender_instance_id).toBe(SENDER);
    expect(isKernelIssuedBinding(binding)).toBe(true);
  });

  it('负向：Object.create(SenderBinding.prototype) 过 instanceof 但过不了签发登记', () => {
    const forged = Object.create(SenderBinding.prototype) as SenderBinding;
    // 原型链伪造：instanceof 为真 —— 这正是 v1.1 的漏洞
    expect(forged instanceof SenderBinding).toBe(true);
    // 但从未经 bind() 登记，三合一判据必须为假
    expect(isKernelIssuedBinding(forged)).toBe(false);
  });

  it('负向：事后在原型链上补齐字段并冻结，仍然不是内核签发（登记缺失）', () => {
    const forged = Object.create(SenderBinding.prototype) as Record<string, unknown>;
    Object.assign(forged, {
      sender_instance_id: SENDER,
      group_id: GROUP,
      task_id: TASK,
      bound_by_kernel: true,
    });
    Object.freeze(forged);
    expect(forged instanceof SenderBinding).toBe(true);
    expect(Object.isFrozen(forged)).toBe(true);
    expect(isKernelIssuedBinding(forged)).toBe(false);
  });

  it('负向：结构化字面量（含全部公开字段）连 instanceof 都过不了', () => {
    const literal = {
      sender_instance_id: SENDER,
      group_id: GROUP,
      task_id: TASK,
      bound_by_kernel: true as const,
    };
    expect(isKernelIssuedBinding(literal)).toBe(false);
    expect(isKernelIssuedBinding(Object.freeze({ ...literal }))).toBe(false);
    expect(isKernelIssuedBinding(null)).toBe(false);
    expect(isKernelIssuedBinding(undefined)).toBe(false);
    expect(isKernelIssuedBinding({ ...binding })).toBe(false);
  });

  it('负向：bind 出的每个实例各自登记（不共享身份），且不同群/任务生成不同绑定', () => {
    const other = SenderBinding.bind(SENDER, { group_id: OTHER_GROUP, task_id: OTHER_TASK });
    expect(other).not.toBe(binding);
    expect(isKernelIssuedBinding(other)).toBe(true);
    expect(other.group_id).toBe(OTHER_GROUP);
    expect(other.task_id).toBe(OTHER_TASK);
    expect(binding.group_id).toBe(GROUP);
  });
});

describe('createMessage（P8：发送者身份由内核绑定）', () => {
  it('落库消息的 sender 恒等于签发值，并带上 sender_binding（冻结记录的一部分）', () => {
    const message = createMessage(baseDraft, binding, { idSource });
    expect(message.sender_instance_id).toBe(SENDER);
    expect(message.sender_binding).toBe(binding);
    expect(message.sender_binding.sender_instance_id).toBe(message.sender_instance_id);
    expect(message.recipient_instance_id).toBe(RECEIVER);
    expect(message.addressed_via).toBe('recipient');
    expect(Object.isFrozen(message)).toBe(true);
  });

  it('模型即使夹带 sender_instance_id 也不会生效（运行时字段约束）', () => {
    const tampered = {
      ...baseDraft,
      sender_instance_id: asInstanceId('FORGED'),
      trust_label: 'kernel' as const,
    } as MessageDraft;
    const message = createMessage(tampered, binding, { idSource });
    expect(message.sender_instance_id).toBe(SENDER);
    expect(message.sender_instance_id).not.toBe(asInstanceId('FORGED'));
  });

  it('缺可信上下文 / 伪造绑定一律抛 ValidationError（R35.2 第 1 项、R35.3）', () => {
    // Object.create 伪造（原型链上像，但未登记）
    const prototypeForged = Object.create(SenderBinding.prototype) as SenderBinding;
    expect(() => createMessage(baseDraft, prototypeForged, { idSource })).toThrow(ValidationError);

    // 结构等价字面量
    const literalForged = {
      sender_instance_id: SENDER,
      group_id: GROUP,
      task_id: TASK,
      bound_by_kernel: true as const,
    };
    expect(() =>
      createMessage(baseDraft, literalForged as unknown as SenderBinding, { idSource }),
    ).toThrow(ValidationError);

    // 完全缺失（模型侧漏传）
    expect(() =>
      createMessage(baseDraft, undefined as unknown as SenderBinding, { idSource }),
    ).toThrow(ValidationError);
    expect(() =>
      createMessage(baseDraft, null as unknown as SenderBinding, { idSource }),
    ).toThrow(ValidationError);
  });

  it('绑定与消息必须同源：跨群绑定被拒绝（R35.2 第 3 项）', () => {
    const crossGroup = SenderBinding.bind(SENDER, { group_id: OTHER_GROUP, task_id: TASK });
    expect(isKernelIssuedBinding(crossGroup)).toBe(true);
    expect(() => createMessage(baseDraft, crossGroup, { idSource })).toThrow(ValidationError);
  });

  it('绑定与消息必须同源：跨任务绑定被拒绝（R35.2 第 3 项）', () => {
    const crossTask = SenderBinding.bind(SENDER, { group_id: GROUP, task_id: OTHER_TASK });
    expect(isKernelIssuedBinding(crossTask)).toBe(true);
    expect(() => createMessage(baseDraft, crossTask, { idSource })).toThrow(ValidationError);
  });

  it('同群同任务的另一身份绑定可用（合法同群协作，对照组）', () => {
    const collaborator = SenderBinding.bind(asInstanceId('S9'), {
      group_id: GROUP,
      task_id: TASK,
    });
    const message = createMessage(baseDraft, collaborator, { idSource });
    expect(message.sender_instance_id).toBe(asInstanceId('S9'));
    expect(message.task_id).toBe(TASK);
    expect(message.group_id).toBe(GROUP);
  });

  /**
   * 冻结副本改 `sender_instance_id` 的负向（R35.2 第 2 项）。
   *
   * 拒绝该副本是**入口鉴权层（E 的 on-message 默认鉴权器）**的职责；协议层能保证的是：
   * `sender_binding` 是内核签发且不可变的，副本改了 `sender_instance_id` 之后必然与
   * `sender_binding.sender_instance_id` 不一致 —— 鉴权器凭此可判定伪造。
   */
  it('负向：冻结副本改 sender_instance_id 后，与 sender_binding 不一致（可被入口鉴权发现）', () => {
    const original = createMessage(baseDraft, binding, { idSource });
    const forgedCopy: GroupMessage = Object.freeze({
      ...original,
      sender_instance_id: asInstanceId('FORGED'),
    });
    // 副本自身被冻结，且 binding 仍是内核签发的合法对象……
    expect(Object.isFrozen(forgedCopy)).toBe(true);
    expect(isKernelIssuedBinding(forgedCopy.sender_binding)).toBe(true);
    // ……但身份已与绑定不一致：R35.2 第 2 项的判据在此必然为假。
    expect(forgedCopy.sender_binding.sender_instance_id).toBe(SENDER);
    expect(forgedCopy.sender_instance_id).not.toBe(forgedCopy.sender_binding.sender_instance_id);
    // 原消息不受影响，绑定不可被借道改动
    expect(original.sender_instance_id).toBe(SENDER);
    expect(original.sender_binding.sender_instance_id).toBe(SENDER);
  });

  /**
   * 编译期名义化：`SenderBinding` 有私有成员，结构等价类型不可赋值。
   * 运行时判据已升级（见上），这里只固化编译期这一层。
   */
  it('含全部公开字段的等价结构：编译期不可赋值给 SenderBinding', () => {
    const structurallyComplete = {
      sender_instance_id: SENDER,
      group_id: GROUP,
      task_id: TASK,
      bound_by_kernel: true as const,
    };
    // @ts-expect-error SenderBinding 有私有成员，缺少私有成员 kernelBound（仅编译期约束）
    const _notBindable: SenderBinding = structurallyComplete;
    expect(isKernelIssuedBinding(structurallyComplete)).toBe(false);
  });

  // 编译期约束：MessageDraft 没有 sender 字段（多余字段被拒绝）。
  it('编译期：MessageDraft 不接受 sender 字段', () => {
    expect(() => {
      createMessage(
        { ...baseDraft, sender_instance_id: SENDER } as MessageDraft,
        binding,
        { idSource },
      );
    }).not.toThrow();
    // 下面这行是真正的编译期断言（多写的字段会导致 tsc 报错）。
    const factory = (): GroupMessage =>
      // @ts-expect-error MessageDraft 不含 sender_instance_id，模型不得自带身份
      createMessage({ ...baseDraft, sender_instance_id: SENDER }, binding, { idSource });
    expect(factory().sender_instance_id).toBe(SENDER);
  });
});

describe('message_id（合同 Q3-a）', () => {
  it('省略时由内核生成', () => {
    const source = createIdSource({ seed: 'unit' });
    const first = createMessage(baseDraft, binding, { idSource: source });
    const second = createMessage(baseDraft, binding, { idSource: source });
    expect(first.message_id).toBe(asMessageId('unit/msg-1'));
    expect(second.message_id).toBe(asMessageId('unit/msg-2'));
  });

  it('必须接受测试直接注入任意 message_id（A04 依赖）', () => {
    const injected = asMessageId('injected-by-test-0001');
    const message = createMessage({ ...baseDraft, message_id: injected }, binding, { idSource });
    expect(message.message_id).toBe(injected);
  });
});

describe('路由（合同 Q1-c / Q2-a：显式实例标识）', () => {
  it('target_capability 只作溯源，接收者恒为具体实例', () => {
    const message = createMessage(
      { ...baseDraft, target_capability: asCapabilityId('spreadsheet') },
      binding,
      { idSource },
    );
    expect(message.addressed_via).toBe('target_capability');
    expect(message.target_capability).toBe(asCapabilityId('spreadsheet'));
    expect(message.recipient_instance_id).toBe(RECEIVER);
  });

  it('缺少解析后的 recipient 时拒绝构造', () => {
    const broken = { ...baseDraft, recipient_instance_id: undefined } as unknown as MessageDraft;
    expect(() => createMessage(broken, binding, { idSource })).toThrow(ValidationError);
  });
});
