import { describe, expect, it } from 'vitest';

import {
  applyTaskControlIntent,
  asLogicalTime,
  asMessageId,
  asRevision,
  asTaskId,
  createTaskControlState,
  isTaskCancelled,
  TASK_CONTROL_INTENTS,
  ValidationError,
} from './index.js';

const TASK = asTaskId('T1');
const T0 = asLogicalTime(0);

function state(revision = 1) {
  return createTaskControlState({ task_id: TASK, updated_at: T0, revision: asRevision(revision) });
}

describe('任务控制状态（v1.1 B4：取消与需求更新优先写入任务状态）', () => {
  it('初始状态：未取消、无待处理需求更新、epoch 为 0', () => {
    const initial = state();
    expect(initial.cancelled).toBe(false);
    expect(initial.requirement_update_pending).toBe(false);
    expect(initial.control_epoch).toBe(0);
    expect(isTaskCancelled(initial)).toBe(false);
    expect(isTaskCancelled(undefined)).toBe(false);
  });

  it('两种控制意图种类与任务书 §9.3 一致', () => {
    expect([...TASK_CONTROL_INTENTS]).toEqual(['cancel', 'requirement_update']);
  });

  it('取消：置 cancelled 并记录原因与消息 id，epoch 递增', () => {
    const cancelled = applyTaskControlIntent(state(), {
      kind: 'cancel',
      message_id: asMessageId('m-cancel'),
      task_revision: asRevision(1),
      at: asLogicalTime(10),
      reason: '用户取消了这次安排',
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.cancel_reason).toBe('用户取消了这次安排');
    expect(cancelled.cancelled_by_message_id).toBe(asMessageId('m-cancel'));
    expect(cancelled.control_epoch).toBe(1);
    expect(cancelled.updated_at).toBe(asLogicalTime(10));
    expect(isTaskCancelled(cancelled)).toBe(true);
  });

  it('需求更新：标记 pending 但不改变取消状态', () => {
    const updated = applyTaskControlIntent(state(), {
      kind: 'requirement_update',
      message_id: asMessageId('m-update'),
      task_revision: asRevision(2),
      at: asLogicalTime(20),
    });
    expect(updated.requirement_update_pending).toBe(true);
    expect(updated.cancelled).toBe(false);
    expect(updated.revision).toBe(asRevision(2));
    expect(updated.last_control_message_id).toBe(asMessageId('m-update'));
  });

  it('取消优先：已取消的任务不会被后续需求更新"复活"', () => {
    const cancelled = applyTaskControlIntent(state(), {
      kind: 'cancel',
      message_id: asMessageId('m-cancel'),
      task_revision: asRevision(1),
      at: asLogicalTime(10),
    });
    const afterUpdate = applyTaskControlIntent(cancelled, {
      kind: 'requirement_update',
      message_id: asMessageId('m-update'),
      task_revision: asRevision(2),
      at: asLogicalTime(20),
    });
    expect(afterUpdate.cancelled).toBe(true);
    expect(afterUpdate.cancel_reason).toBe(cancelled.cancel_reason);
    expect(afterUpdate.requirement_update_pending).toBe(true);
    expect(afterUpdate.control_epoch).toBe(2);
  });

  it('旧任务版本的控制意图不得改写控制状态（Q1-b）', () => {
    const current = state(3);
    expect(() =>
      applyTaskControlIntent(current, {
        kind: 'cancel',
        message_id: asMessageId('m-old'),
        task_revision: asRevision(2),
        at: asLogicalTime(30),
      }),
    ).toThrow(ValidationError);
  });

  it('同版本控制意图仍然受理（只拦"旧于当前版本"）', () => {
    const applied = applyTaskControlIntent(state(2), {
      kind: 'cancel',
      message_id: asMessageId('m-same'),
      task_revision: asRevision(2),
      at: asLogicalTime(40),
    });
    expect(applied.cancelled).toBe(true);
  });
});
