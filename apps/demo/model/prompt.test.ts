/**
 * S4 —— 提示词内容用例（fixture，无网络、无额度）。
 *
 * ⚠️ 口径声明：本组用例只能证明「约束**确实写进了**提示词」，
 * **不能**证明「模型会照做」。后者只能靠真实模型验证。
 * 不要拿这组绿去宣称任何模型行为已被修复。
 */

import { describe, expect, it } from 'vitest';
import { DELIBERATION_TRIGGERS, MODEL_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

describe('MODEL_SYSTEM_PROMPT —— 主题忠实约束已写入', () => {
  it('存在「主题忠实」小节，且排在「事实约束」之前', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('# 主题忠实');
    expect(MODEL_SYSTEM_PROMPT).toContain('# 事实约束');
    expect(MODEL_SYSTEM_PROMPT.indexOf('# 主题忠实')).toBeLessThan(
      MODEL_SYSTEM_PROMPT.indexOf('# 事实约束'),
    );
  });

  it('要求标题与正文紧扣用户请求的场合/对象/体裁', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('场合、对象、体裁');
    expect(MODEL_SYSTEM_PROMPT).toContain('必须紧扣它们');
  });

  it('守题要求是**可直接判定的陈述式规则**', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('`title` 必须包含用户请求中的核心对象词');
    expect(MODEL_SYSTEM_PROMPT).toContain('不得出现用户请求未提及的节日、季节、机构或事件');
  });

  it('保留一个简短反例，且不展开成长段落', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('读书会邀请函');
    expect(MODEL_SYSTEM_PROMPT).toContain('新年贺词');
    expect(MODEL_SYSTEM_PROMPT).toContain('错误输出');
  });

  it('信息不足时写占位而不是换题', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('需要补充资料');
    expect(MODEL_SYSTEM_PROMPT).toContain('不得自行填值');
  });
});

describe('MODEL_SYSTEM_PROMPT —— 原有约束没有被削弱', () => {
  it('JSON 形状与「不要解释/不要围栏/不要思考过程」仍然在', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('{"title":"标题","paragraphs":[{"id":"p1","text":"第一段"}');
    expect(MODEL_SYSTEM_PROMPT).toContain('只输出一个 JSON 对象');
    expect(MODEL_SYSTEM_PROMPT).toContain('不要思考过程');
  });

  it('段落数、字数、纯文本等校验口径一字未动', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('2 到 4 段');
    expect(MODEL_SYSTEM_PROMPT).toContain('60 到 150 字');
    expect(MODEL_SYSTEM_PROMPT).toContain('2000 字');
    expect(MODEL_SYSTEM_PROMPT).toContain('禁止出现 HTML 标签、Markdown 语法或文件名');
  });

  it('事实约束三条仍在（不编造 / 占位 / 不声称已核实）', () => {
    expect(MODEL_SYSTEM_PROMPT).toContain('不得编造人数、金额、日期');
    expect(MODEL_SYSTEM_PROMPT).toContain('不要声称文稿内容已被核实');
  });
});

/**
 * 回归护栏一：**不得再出现诱导模型"先审议再作答"的祈使句**。
 *
 * 理由：本机模型 `thinking` 与正文**共用 `max_tokens`**（已实测的事实）。
 * 「先自检、不通过就重写」这类祈使句字面上要求作答前多一轮审议，与共用预算相冲。
 * 注意这条改动**不是**由某次 0 输出实验推出的因果（那次实验的输入是乱码，结论不可用），
 * 而是由"共用预算"这一已证事实独立支撑。
 */
describe('REGRESSION —— 提示词不得诱导思考', () => {
  it('不含任何祈使式"先审议再输出"的措辞', () => {
    for (const trigger of DELIBERATION_TRIGGERS) {
      expect(
        MODEL_SYSTEM_PROMPT.includes(trigger),
        `提示词不得包含诱导审议的措辞「${trigger}」（会推长 thinking，挤掉正文预算）`,
      ).toBe(false);
    }
  });

  it('不再有旧版「输出前自检…就重写」的措辞', () => {
    expect(MODEL_SYSTEM_PROMPT).not.toContain('输出前自检');
    expect(MODEL_SYSTEM_PROMPT).not.toContain('任一为「否」');
    expect(MODEL_SYSTEM_PROMPT).not.toContain('就重写');
  });
});

/**
 * 回归护栏二：**提示词越短越好**。
 *
 * 理由同上——提示词越长、要求越多，越容易把输出预算推向思考（thinking 与正文共用）。
 * 这条会在有人往提示词里继续堆约束时失败，提醒先问"不加会不会出事"。
 */
describe('REGRESSION —— 提示词保持简短', () => {
  it('系统提示词长度不超过 900 字符', () => {
    expect(
      MODEL_SYSTEM_PROMPT.length,
      `当前 ${MODEL_SYSTEM_PROMPT.length} 字符；提示词越长越费 thinking 预算，新增约束前先确认必要性`,
    ).toBeLessThanOrEqual(900);
  });

  it('不超过 26 行（空行与换行也算）', () => {
    expect(MODEL_SYSTEM_PROMPT.split('\n').length).toBeLessThanOrEqual(26);
  });
});

describe('buildUserPrompt', () => {
  it('原样保留用户请求，并再次强调只输出 JSON', () => {
    const instruction = '为新生读书会写一封温暖的邀请函，不编造时间地点和报名联系方式。';
    const prompt = buildUserPrompt(instruction);
    expect(prompt).toContain(instruction);
    expect(prompt).toContain('请仅按系统消息规定的 JSON 形状');
    // 不追加任何事实、不替用户扩写主题。
    expect(prompt).not.toContain('新年');
  });
});
