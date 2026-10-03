/** 注册 `js-to-ts-loader.mjs`（见该文件的说明）。仅测试用。 */
import { register } from 'node:module';

register('./js-to-ts-loader.mjs', import.meta.url);
