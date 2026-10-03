/**
 * APP-08（中文输入法 / 长文本 / 多文件 / 屏幕旋转恢复 / 大字与基本可访问性
 * + 核心流程不展示内部 Agent 群聊、不要求理解工程术语）—— **源码级结构断言**。
 *
 * 判据（都可机判，关键判据用**合成坏样本**自证会变红）：
 *   ① 有名字的区域都有 {@code contentDescription} 资源，且都能被映射到；
 *   ② 跟随系统字号（大字模式），并把缩放**夹在上下限之间**；
 *   ③ 旋转/字号变化**就地处理**（清单 configChanges），不重建 Activity；
 *   ④ 输入法不被遮挡：{@code windowSoftInputMode="adjustResize"}，且宿主**不**屏蔽焦点/输入；
 *   ⑤ 长文本草稿能跨进程重建恢复，且**超长不截断**；
 *   ⑥ 多文件入口存在（EXTRA_ALLOW_MULTIPLE + ClipData）；
 *   ⑦ ★面向用户的文案里**不出现内部术语白名单词**；
 *   ⑧ ★面向用户的文案不硬编码在 Java 里（本包四个类里没有中文串字面量）；
 *   ⑨ 四个类引用的每个字符串资源都真的存在（跨文件交叉核对）。
 *
 * ⚠️ **未验证（需真机）**：真实中文输入法候选词行为、TalkBack 朗读顺序、
 * 各家 ROM 的大字档位，本包**没有设备**，未验证。
 */

import { describe, expect, it } from 'vitest';

import {
  ACCESSIBILITY,
  ANDROID_MANIFEST,
  INPUT_GATEWAY,
  MAIN_ACTIVITY,
  NEW_CLASSES,
  STRINGS_XML,
  cjkStringLiterals,
  commentLeakMarkers,
  extractMethodBody,
  findInternalTerminology,
  javaStringLiterals,
  readText,
  referencedStringResources,
  resourceTexts,
  stripJavaComments,
} from './android-input-source.js';

const a11y = readText(ACCESSIBILITY);
const a11yCode = stripJavaComments(a11y);
const gateway = readText(INPUT_GATEWAY);
const activity = readText(MAIN_ACTIVITY);
const manifest = readText(ANDROID_MANIFEST);
const stringsXml = readText(STRINGS_XML);
const strings = resourceTexts(stringsXml);

// ---------------------------------------------------------------------------
// 合成坏样本（判别力自证）
// ---------------------------------------------------------------------------

/** 面向用户文案里出现内部术语的坏样本。 */
const LEAKY_COPY = '已创建 3 个 Agent 组成群聊，正在并行处理。';

/** 把用户可见文案硬编码进 Java 的坏样本。 */
const HARDCODED_JAVA = 'String msg = "这个文件不支持";';

/** 重建 Activity 式旋转处理（清单没声明 configChanges）的坏样本。 */
const RECREATING_MANIFEST = '<activity android:name=".MainActivity" android:exported="true">';

// ---------------------------------------------------------------------------

describe('判别力自证（合成坏样本必须被抓）', () => {
  it('面向用户文案带内部术语 → 术语守卫抓得到', () => {
    const hits = findInternalTerminology(LEAKY_COPY).join(';');
    expect(hits).toContain('agent(EN)');
    expect(hits).toContain('群聊');
  });

  it('干净文案零命中（对照臂，防止守卫恒真）', () => {
    expect(findInternalTerminology('已收到文件：季度报告.docx。')).toEqual([]);
  });

  it('Java 里硬编码中文文案 → 中文串字面量判据抓得到', () => {
    expect(cjkStringLiterals(HARDCODED_JAVA).length).toBeGreaterThan(0);
  });

  it('没有声明 configChanges 的清单 → 旋转就地处理判据为假', () => {
    expect(RECREATING_MANIFEST).not.toContain('android:configChanges');
    expect(manifest).toContain('android:configChanges');
  });
});

describe('★面向用户的文案不出现内部术语（APP-08）', () => {
  it('strings.xml 的全部文案零命中', () => {
    const bad: string[] = [];
    for (const [name, text] of strings) {
      const hits = findInternalTerminology(text);
      if (hits.length > 0) bad.push(`${name}: ${hits.join(';')}`);
    }
    expect(bad, `面向用户文案出现内部术语：\n${bad.join('\n')}`).toEqual([]);
  });

  it('本包四个类的字符串字面量零命中（状态码/JSON 键不算用户可见文案，但也不许带术语）', () => {
    const bad: string[] = [];
    for (const path of NEW_CLASSES) {
      for (const literal of javaStringLiterals(readText(path))) {
        const hits = findInternalTerminology(literal);
        if (hits.length > 0) bad.push(`${path}: "${literal}" → ${hits.join(';')}`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('面向用户文案不在 Java 里硬编码：四个类没有中文串字面量', () => {
    for (const path of NEW_CLASSES) {
      const cjk = cjkStringLiterals(readText(path));
      expect(cjk, `${path} 里硬编码了中文文案：${cjk.join(' | ')}`).toEqual([]);
    }
  });

  it('★注释没有提前闭合（javadoc 里出现 `*` 紧跟 `/` 会让注释就地结束——是编译错误）', () => {
    // 合成样本自证：这里第二个注释块会**提前**闭合，后面的中文明文漏进"代码"。
    const leaking = '/** 文档里写 {@code *' + '/*} 就完了 */\nString x = 1; // 后续中文注释';
    expect(commentLeakMarkers(leaking).length).toBeGreaterThan(0);

    for (const path of NEW_CLASSES) {
      const markers = commentLeakMarkers(readText(path));
      expect(markers, `${path}：${markers.join('；')}`).toEqual([]);
    }
  });
});

describe('可访问性：有名字的区域都有朗读文案', () => {
  it('四个区域名映射到四个**不同**的资源', () => {
    const body = extractMethodBody(a11yCode, 'public static int contentDescRes(') ?? '';
    const resources = [...body.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined);
    expect(resources.length).toBe(4);
    expect(new Set(resources).size).toBe(4);
    for (const res of resources) {
      expect(strings.get(res), `strings.xml 缺少 ${res}`).toBeTruthy();
    }
  });

  it('拿不到文案时静默跳过，而不是设空串冒充（空串会被读成"空白"）', () => {
    const body = extractMethodBody(a11yCode, 'public static void applyContentDescription(') ?? '';
    expect(body.replace(/\s+/g, ' ')).toMatch(/if \(view == null \|\| resId == 0\) \{ return;/);
  });

  it('可点区域最小边长给到平台建议值 48dp', () => {
    expect(a11yCode).toMatch(/MIN_TOUCH_TARGET_DP\s*=\s*48/);
  });

  it('宿主把主内容区的朗读文案挂上 WebView', () => {
    expect(activity).toContain('webView.setContentDescription(getString(R.string.potbot_a11y_content_desc))');
  });
});

describe('大字模式（跟随系统字号）', () => {
  it('缩放跟随 fontScale 并夹在 100–200 之间', () => {
    expect(a11yCode).toMatch(/TEXT_ZOOM_MIN_PERCENT\s*=\s*100/);
    expect(a11yCode).toMatch(/TEXT_ZOOM_MAX_PERCENT\s*=\s*200/);
    const body = extractMethodBody(a11yCode, 'public static int textZoomPercent(') ?? '';
    expect(body).toContain('fontScale(context)');
    expect(body).toContain('TEXT_ZOOM_MIN_PERCENT');
    expect(body).toContain('TEXT_ZOOM_MAX_PERCENT');
  });

  it('大字模式判定用阈值，不是硬编码布尔', () => {
    expect(a11yCode).toMatch(/LARGE_FONT_SCALE_THRESHOLD\s*=\s*1\.3f/);
    const body = extractMethodBody(a11yCode, 'public static boolean isLargeFont(') ?? '';
    expect(body).toContain('LARGE_FONT_SCALE_THRESHOLD');
  });

  it('宿主把缩放应用到 WebView，并在配置变化时就地重算', () => {
    expect(activity).toContain('s.setTextZoom(PotbotAccessibility.textZoomPercent(this))');
    const onConfig = extractMethodBody(activity, 'public void onConfigurationChanged(') ?? '';
    expect(onConfig).toContain('setTextZoom(PotbotAccessibility.textZoomPercent(this))');
  });
});

describe('旋转/恢复与输入法', () => {
  it('清单声明就地处理旋转与键盘变化（不重建 Activity，页面输入天然保留）', () => {
    const m = /android:configChanges="([^"]+)"/.exec(manifest);
    const declared = (m?.[1] ?? '').split('|');
    for (const key of ['orientation', 'screenSize', 'keyboardHidden', 'smallestScreenSize', 'screenLayout']) {
      expect(declared, `configChanges 少了 ${key}`).toContain(key);
    }
  });

  it('输入法不被遮挡：windowSoftInputMode=adjustResize', () => {
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
  });

  it('宿主不屏蔽焦点/输入（否则中文输入法用不了）', () => {
    expect(activity).not.toContain('setFocusable(false)');
    expect(activity).not.toContain('setDescendantFocusability(');
    expect(activity).not.toContain('SOFT_INPUT_STATE_ALWAYS_HIDDEN');
  });

  it('长文本草稿跨进程恢复：有键、有写有读，且超长**不截断**', () => {
    expect(a11yCode).toContain('STATE_COMPOSER_DRAFT');
    const put = extractMethodBody(a11yCode, 'public static void putDraft(') ?? '';
    expect(put).toContain('MAX_DRAFT_CHARS');
    expect(put).not.toContain('substring');
    expect(put).toContain('remove(STATE_COMPOSER_DRAFT)');
    const get = extractMethodBody(a11yCode, 'public static String getDraft(') ?? '';
    expect(get).toContain('getString(STATE_COMPOSER_DRAFT)');
  });

  it('宿主在 onSaveInstanceState 存、在 onCreate 取', () => {
    const save = extractMethodBody(activity, 'protected void onSaveInstanceState(') ?? '';
    expect(save).toContain('PotbotAccessibility.putDraft(outState, composerDraft)');
    expect(activity).toContain('composerDraft = PotbotAccessibility.getDraft(savedInstanceState)');
    expect(activity).toMatch(/public\s+void\s+reportComposerDraft\(String draft\)/);
    expect(activity).toMatch(/public\s+String\s+readComposerDraft\(\)/);
  });

  it('多文件入口存在（EXTRA_ALLOW_MULTIPLE + ClipData）', () => {
    const code = stripJavaComments(gateway);
    expect(code).toContain('EXTRA_ALLOW_MULTIPLE');
    expect(code).toContain('getClipData');
    expect(code).toContain('getItemCount');
  });

  it('长文本上限与草稿上限一致', () => {
    expect(a11yCode).toMatch(/MAX_DRAFT_CHARS\s*=\s*PotbotInputGateway\.MAX_TEXT_CHARS/);
  });
});

describe('跨文件交叉核对：引用的资源必须存在', () => {
  it('本包四个类引用的每个 R.string 都在 strings.xml 里', () => {
    const missing: string[] = [];
    for (const path of NEW_CLASSES) {
      for (const res of referencedStringResources(readText(path))) {
        if (!strings.has(res)) missing.push(`${path} → ${res}`);
      }
    }
    expect(missing, `引用了不存在的资源：\n${missing.join('\n')}`).toEqual([]);
  });

  it('反过来：本包新增的文案资源都被某个类引用（没有写了不用的死文案）', () => {
    const referenced = new Set<string>();
    for (const path of NEW_CLASSES) {
      for (const res of referencedStringResources(readText(path))) referenced.add(res);
    }
    const declared = [...strings.keys()].filter((k) => k.startsWith('potbot_input_')
        || k.startsWith('potbot_file_') || k.startsWith('potbot_account_')
        || k.startsWith('potbot_a11y_'));
    expect(declared.length).toBeGreaterThan(20);
    // a11y 的四个区域名由 contentDescRes 引用；input/file/account 由 messageRes 引用。
    const unreferenced = declared.filter((k) => !referenced.has(k));
    expect(unreferenced, `这些文案没有被任何类引用：${unreferenced.join(', ')}`).toEqual([]);
  });
});
