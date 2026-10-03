/**
 * KRN-04 下半：**受约束响应解析** —— 封闭的动作/回答联合、格式违约结构化拒绝、
 * 自由文本绝不当作工具调用执行。
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 合规动作信封（对象与 JSON 字符串两种输入）⇒ `kind: action`，`executed === false` | 正例 |
 * | 2 | 合规回答信封 ⇒ `kind: answer` | 正例 |
 * | 3 | **自由文本**（含"文本里嵌着一段 JSON 工具调用"）⇒ `free_text_not_action` | **反例（核心）** |
 * | 4 | 以 `{` 开头但 JSON 不合法（含尾随文本）⇒ `malformed_json` | 反例 |
 * | 5 | 非对象（数组 / 数字 / null）⇒ `not_an_object` | 反例 |
 * | 6 | 缺 `kind` / `kind` 未知 ⇒ `missing_kind` / `unknown_kind` | 反例 |
 * | 7 | 未知工具名（含缺失 / 非字符串的 `tool`）⇒ `unknown_tool` | **反例（具名）** |
 * | 8 | 越界数值参数 ⇒ `argument_out_of_range` | **反例（具名）** |
 * | 9 | 多余参数（`arguments` 里未声明）⇒ `unknown_argument` | **反例（具名）** |
 * | 10 | 信封多余字段 ⇒ `unknown_envelope_field` | **反例（具名）** |
 * | 11 | 缺必填 / 类型不符 / 枚举越界 ⇒ 各自具名码 | 反例 |
 * | 12 | 空回答 ⇒ `empty_answer_text` | 反例 |
 * | 13 | **对照**：同一形状的合规版本全部通过（拒绝来自违约本身，不是"什么都不通过"） | **对照** |
 * | 14 | `violation` 区分格式违约与参数违约 | 正例 |
 * | 15 | 目录不自洽（工具重名 / 参数重名 / 区间颠倒）⇒ 抛 `ValidationError` | 反例 |
 * | 16 | `JsonType` 词汇与 `src/adapters/clock/action-contract.ts` 一致 | 对照 |
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../protocol/index.js';
import type { JsonType } from '../adapters/clock/action-contract.js';
import {
  createToolCatalog,
  describeResponseRejection,
  findToolSpec,
  isAnswer,
  isToolAction,
  mustAcceptResponse,
  parseConstrainedResponse,
  rejectionViolationOf,
  type ToolCatalog,
} from './constrained-response.js';

const CATALOG: ToolCatalog = createToolCatalog([
  {
    tool_id: 'doc.write',
    summary: '写一份文档',
    parameters: [
      { name: 'path', type: 'string', required: true, description: '目标文件名' },
      { name: 'paragraphs', type: 'number', required: false, description: '段落数', minimum: 1, maximum: 50 },
      {
        name: 'format',
        type: 'string',
        required: false,
        description: '格式',
        enum_values: ['docx', 'md'],
      },
    ],
  },
  { tool_id: 'clock.now', summary: '读当前时间', parameters: [] },
]);

describe('KRN-04 受约束响应解析', () => {
  it('1. 合规动作信封（对象输入）通过，且 executed 恒为 false（解析不是执行）', () => {
    const outcome = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 3 } },
      CATALOG,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.executed).toBe(false);
    expect(outcome.accepted).toBe(true);
    expect(isToolAction(outcome.response)).toBe(true);
    expect(outcome.response).toMatchObject({
      kind: 'action',
      tool_id: 'doc.write',
      arguments: { path: 'a.docx', paragraphs: 3 },
    });
  });

  it('1b. 合规动作信封（JSON 字符串输入，常见于真实模型输出）同样通过', () => {
    const raw = JSON.stringify({ kind: 'action', tool: 'clock.now', arguments: {} });
    const outcome = parseConstrainedResponse(raw, CATALOG);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isToolAction(outcome.response)).toBe(true);
    expect(outcome.executed).toBe(false);
  });

  it('2. 合规回答信封 ⇒ kind: answer', () => {
    const outcome = parseConstrainedResponse({ kind: 'answer', text: '已按你的要求完成。' }, CATALOG);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isAnswer(outcome.response)).toBe(true);
    expect(outcome.response).toMatchObject({ kind: 'answer', text: '已按你的要求完成。' });
  });

  it('3. 自由文本被结构化拒绝：不猜测、不当作工具调用（核心反例）', () => {
    const outcome = parseConstrainedResponse('好的，我这就去写文档。', CATALOG);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('free_text_not_action');
    expect(outcome.violation).toBe('format');
    expect(outcome.executed).toBe(false);
    expect(outcome.accepted).toBe(false);
    expect(describeResponseRejection(outcome.code)).toContain('自由文本');
  });

  it('3b. 自由文本里**嵌着**一段 JSON 工具调用：整段被拒，绝不抽出那段去执行', () => {
    const embedded =
      '好的，我来调用工具：{"kind":"action","tool":"doc.write","arguments":{"path":"a.docx","paragraphs":3}}，请稍候。';
    const outcome = parseConstrainedResponse(embedded, CATALOG);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('free_text_not_action');
    // 关键：返回值里**没有**任何可执行的动作。
    expect(JSON.stringify(outcome)).not.toContain('"kind":"action"');
  });

  it('4. 以 { 开头但不是合法 JSON（含尾随文本）⇒ malformed_json', () => {
    const trailing = '{"kind":"answer","text":"ok"} 以上是回答';
    const outcome = parseConstrainedResponse(trailing, CATALOG);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('malformed_json');
    expect(outcome.violation).toBe('format');
  });

  it('5. 非对象（数组 / 数字 / null）⇒ not_an_object', () => {
    for (const raw of [[{ kind: 'action' }], 42, null, '[1,2]']) {
      const outcome = parseConstrainedResponse(raw, CATALOG);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe('not_an_object');
    }
  });

  it('6. 缺 kind / kind 未知 ⇒ missing_kind / unknown_kind', () => {
    const missing = parseConstrainedResponse({ tool: 'doc.write' }, CATALOG);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('missing_kind');

    const unknown = parseConstrainedResponse({ kind: 'tool_call', tool: 'doc.write' }, CATALOG);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('unknown_kind');

    const nonString = parseConstrainedResponse({ kind: 7 }, CATALOG);
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) expect(nonString.code).toBe('unknown_kind');
  });

  it('7. 未知工具名具名拒绝（含缺失 / 非字符串的 tool）', () => {
    const unknown = parseConstrainedResponse({ kind: 'action', tool: 'doc.deleteAll', arguments: {} }, CATALOG);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe('unknown_tool');
      expect(unknown.violation).toBe('argument');
      expect(unknown.detail).toContain('doc.write');
    }
    const missing = parseConstrainedResponse({ kind: 'action', arguments: {} }, CATALOG);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('unknown_tool');
    const wrongType = parseConstrainedResponse({ kind: 'action', tool: 42, arguments: {} }, CATALOG);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.code).toBe('unknown_tool');
  });

  it('8. 越界参数具名拒绝（上界与下界都走同一条码）', () => {
    const over = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 999 } },
      CATALOG,
    );
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.code).toBe('argument_out_of_range');
      expect(over.path).toBe('arguments.paragraphs');
      expect(over.detail).toContain('上界');
    }
    const under = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 0 } },
      CATALOG,
    );
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.code).toBe('argument_out_of_range');

    const edge = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 50 } },
      CATALOG,
    );
    expect(edge.ok).toBe(true); // 边界值（含）放行 —— 拒绝来自越界，不是来自"有区间就拒"
  });

  it('9. 多余参数具名拒绝（arguments 里未声明的字段）', () => {
    const outcome = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', font: '宋体' } },
      CATALOG,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unknown_argument');
    expect(outcome.path).toBe('arguments.font');
  });

  it('10. 信封多余字段具名拒绝（action 与 answer 两种信封都封闭）', () => {
    const action = parseConstrainedResponse(
      { kind: 'action', tool: 'clock.now', arguments: {}, thought: '让我想想' },
      CATALOG,
    );
    expect(action.ok).toBe(false);
    if (!action.ok) {
      expect(action.code).toBe('unknown_envelope_field');
      expect(action.path).toBe('thought');
    }
    const answer = parseConstrainedResponse({ kind: 'answer', text: '好的', confidence: 0.9 }, CATALOG);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.code).toBe('unknown_envelope_field');
  });

  it('11. 缺必填 / 类型不符 / 枚举越界各自具名', () => {
    const missing = parseConstrainedResponse({ kind: 'action', tool: 'doc.write', arguments: {} }, CATALOG);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('missing_required_argument');

    const wrongType = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: '三' } },
      CATALOG,
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.code).toBe('argument_type_mismatch');

    const notObject = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: 'a.docx' },
      CATALOG,
    );
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.code).toBe('argument_type_mismatch');

    const badEnum = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', format: 'pdf' } },
      CATALOG,
    );
    expect(badEnum.ok).toBe(false);
    if (!badEnum.ok) expect(badEnum.code).toBe('argument_enum_violation');
  });

  it('12. 空回答具名拒绝（空回答不是回答）', () => {
    for (const text of ['', '   ', '\n']) {
      const outcome = parseConstrainedResponse({ kind: 'answer', text }, CATALOG);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('empty_answer_text');
    }
  });

  it('13. 对照：同一形状的合规版本全部通过（拒绝来自违约本身）', () => {
    const good = parseConstrainedResponse(
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 3, format: 'docx' } },
      CATALOG,
    );
    expect(good.ok).toBe(true);
    // 与第 8/9/11 条**只差违约的那一处**：改动一点点立刻被拒 ⇒ 证明判据是精确的。
    for (const mutated of [
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 3, format: 'docx', extra: 1 } },
      { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx', paragraphs: 3, format: 'pdf' } },
      { kind: 'action', tool: 'doc.write', arguments: { paragraphs: 3, format: 'docx' } },
    ]) {
      expect(parseConstrainedResponse(mutated, CATALOG).ok).toBe(false);
    }
  });

  it('14. violation 区分格式违约与参数违约', () => {
    expect(rejectionViolationOf('free_text_not_action')).toBe('format');
    expect(rejectionViolationOf('missing_kind')).toBe('format');
    expect(rejectionViolationOf('unknown_envelope_field')).toBe('format');
    expect(rejectionViolationOf('unknown_tool')).toBe('argument');
    expect(rejectionViolationOf('argument_out_of_range')).toBe('argument');
  });

  it('15. 目录不自洽即抛错（不静默丢弃）', () => {
    expect(() =>
      createToolCatalog([
        { tool_id: 'a', summary: '', parameters: [] },
        { tool_id: 'a', summary: '', parameters: [] },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      createToolCatalog([
        {
          tool_id: 'a',
          summary: '',
          parameters: [
            { name: 'p', type: 'string', required: false, description: '' },
            { name: 'p', type: 'string', required: false, description: '' },
          ],
        },
      ]),
    ).toThrow(ValidationError);
    expect(() =>
      createToolCatalog([
        {
          tool_id: 'a',
          summary: '',
          parameters: [{ name: 'p', type: 'number', required: false, description: '', minimum: 5, maximum: 1 }],
        },
      ]),
    ).toThrow(ValidationError);
  });

  it('16. 参数类型词汇与 action-contract 的 JsonType 一致（不另造）', () => {
    const jsonType: JsonType = 'number';
    const catalog = createToolCatalog([
      {
        tool_id: 't',
        summary: '',
        parameters: [{ name: 'n', type: jsonType, required: true, description: '数值' }],
      },
    ]);
    expect(findToolSpec(catalog, 't')?.parameters[0]?.type).toBe('number');
    expect(parseConstrainedResponse({ kind: 'action', tool: 't', arguments: { n: 1 } }, catalog).ok).toBe(true);
    expect(parseConstrainedResponse({ kind: 'action', tool: 't', arguments: { n: 'x' } }, catalog).ok).toBe(false);
  });

  it('17. mustAcceptResponse：被拒时抛错而不是静默继续', () => {
    const rejected = parseConstrainedResponse('随便聊两句', CATALOG);
    expect(() => mustAcceptResponse(rejected)).toThrow(ValidationError);
    const accepted = parseConstrainedResponse({ kind: 'answer', text: '好了' }, CATALOG);
    expect(mustAcceptResponse(accepted)).toMatchObject({ kind: 'answer' });
  });
});
