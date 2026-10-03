/**
 * W-R01 CLI 入口（`.mjs`）：注册 `.js`→`.ts` 解析钩子后，动态加载 `map-cli.ts`。
 *
 * 运行：
 *   node tests/mobile-office/word/W-R01/map-cli.mjs
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-specifier-hooks.mjs', pathToFileURL(`${import.meta.dirname}/`));

await import('./map-cli.ts');
