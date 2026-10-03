/**
 * K-I21 契约⑤：源码卫生（无密钥 / 无隐私 / 不越权改清单）。
 *
 * 反向对照：本用例的扫描模式对"含密钥的样例"必须命中，故先对一段**测试内造的**违规文本断言
 * 命中，再对真实源码断言零命中——证明扫描器不是永远为绿的空壳。
 */

import { describe, expect, it } from 'vitest';

import { allJavaSources } from './fixtures.js';

/** 命中即视为违规的源码模式。 */
const FORBIDDEN: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: '桌面绝对路径', re: /[A-Za-z]:[\\/]Users[\\/]/ },
  { label: 'sk- 明文密钥', re: /sk-[A-Za-z0-9]{12,}/ },
  { label: '中国大陆手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { label: '清单权限条目', re: /<uses-permission/ },
];

function scan(source: string): string[] {
  return FORBIDDEN.filter(({ re }) => re.test(source)).map(({ label }) => label);
}

describe('K-I21 ⑤ 源码卫生', () => {
  it('扫描器反面对照：违规文本必须命中（非空壳）', () => {
    // 违规样例在运行时拼接，文件里不落任何真凭据/真实路径/号码字面量。
    const fakeSecret = 'sk-' + 'ABCDEFGHIJKLMNOP';
    const fakePath = 'C:' + '/Users/' + 'someone/Desktop/keys.txt';
    const fakePhone = '138' + '0000' + '1111';
    expect(scan(`String k = "${fakeSecret}";`)).toContain('sk- 明文密钥');
    expect(scan('<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />')).toContain('清单权限条目');
    expect(scan(`path = "${fakePath}"`)).toContain('桌面绝对路径');
    expect(scan(`phone = "${fakePhone}"`)).toContain('中国大陆手机号');
  });

  it('本单元全部原生源码零命中', () => {
    const violations: string[] = [];
    for (const { name, source } of allJavaSources()) {
      for (const label of scan(source)) {
        violations.push(`${name}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
