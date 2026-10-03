/**
 * K-I24 ②：**按 conversation / task 归集**。
 *
 * 归集是纯函数（`catalog.ts` 的 `groupArtifactsBy`），本测试通过宿主端到端驱动，断言：
 *   - 桶 key 升序、桶内 artifactId 升序（结果确定，不随插入顺序漂移）；
 *   - `taskId=null` 的未归属 artifact 进 key=null 的桶，且**排在最后**；
 *   - 同一 conversation 下的多个 task 在任务归集里拆成不同桶。
 */

import { describe, expect, it } from 'vitest';

import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';

import { manualClock, newHost } from './fixtures.js';

describe('K-I24 归集：conversation / task', () => {
  it('按 conversation 归集：桶 key 升序、桶内 artifactId 升序', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });

    await host.publish({ conversationId: 'conv-b', taskId: 't1', fileName: 'b.docx', artifactId: 'art-b', chunks: ['b'] });
    await host.publish({ conversationId: 'conv-a', taskId: 't1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['a'] });
    await host.publish({ conversationId: 'conv-b', taskId: 't2', fileName: 'c.docx', artifactId: 'art-c', chunks: ['c'] });

    const groups = host.groupByConversation();
    expect(groups.map((g) => g.key)).toEqual(['conv-a', 'conv-b']);
    expect(groups[0]!.artifacts.map((a) => a.artifactId)).toEqual(['art-a']);
    expect(groups[1]!.artifacts.map((a) => a.artifactId)).toEqual(['art-b', 'art-c']);
  });

  it('按 task 归集：不同 task 拆桶，未归属（null）排最后', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });

    await host.publish({ conversationId: 'conv-1', fileName: 'free.docx', artifactId: 'art-free', chunks: ['f'] });
    await host.publish({ conversationId: 'conv-1', taskId: 'task-2', fileName: 'b.docx', artifactId: 'art-b', chunks: ['b'] });
    await host.publish({ conversationId: 'conv-1', taskId: 'task-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['a'] });

    const groups = host.groupByTask();
    expect(groups.map((g) => g.key)).toEqual(['task-1', 'task-2', null]);
    expect(groups[0]!.artifacts.map((a) => a.artifactId)).toEqual(['art-a']);
    expect(groups[1]!.artifacts.map((a) => a.artifactId)).toEqual(['art-b']);
    expect(groups[2]!.artifacts.map((a) => a.artifactId)).toEqual(['art-free']);
  });

  it('listArtifacts 支持 conversationId / taskId / hasTask 筛选', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });

    await host.publish({ conversationId: 'conv-1', taskId: 'task-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['a'] });
    await host.publish({ conversationId: 'conv-2', taskId: 'task-1', fileName: 'b.docx', artifactId: 'art-b', chunks: ['b'] });
    await host.publish({ conversationId: 'conv-2', fileName: 'c.docx', artifactId: 'art-c', chunks: ['c'] });

    expect(host.listArtifacts().map((a) => a.artifactId).sort()).toEqual(['art-a', 'art-b', 'art-c']);
    expect(host.listArtifacts({ conversationId: 'conv-2' }).map((a) => a.artifactId).sort()).toEqual(['art-b', 'art-c']);
    expect(host.listArtifacts({ taskId: 'task-1' }).map((a) => a.artifactId).sort()).toEqual(['art-a', 'art-b']);
    expect(host.listArtifacts({ hasTask: false }).map((a) => a.artifactId)).toEqual(['art-c']);
    expect(host.listArtifacts({ hasTask: true }).map((a) => a.artifactId).sort()).toEqual(['art-a', 'art-b']);
  });

  it('空目录下归集返回空数组（干净起点，不是错误）', () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });
    expect(host.groupByConversation()).toEqual([]);
    expect(host.groupByTask()).toEqual([]);
    expect(host.listArtifacts()).toEqual([]);
  });
});
