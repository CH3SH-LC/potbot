// FA-VERIFY-WAVE-3 恒真猎捕扫描器（只读）。
// 找出「guard 之前零 expect、guard 之后有 expect」的用例——那类用例在 guard 触发时
// 一条实质断言都不执行，属于静默通过的空洞用例。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
function walk(d, a = []) {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules') continue;
    const f = join(d, n);
    statSync(f).isDirectory() ? walk(f, a) : a.push(f);
  }
  return a;
}
const files = walk(join(ROOT, 'src')).filter((f) => /\.test\.ts$/.test(f));
const vacuous = [];
const allGuard = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /it\s*\(\s*(['"`])([^\n]*?)\1\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{/g;
  const starts = [];
  let m;
  while ((m = re.exec(src))) starts.push({ idx: m.index, end: re.lastIndex, title: m[2] });
  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1].idx : src.length;
    const body = src.slice(s.end, e);
    const guard = body.search(/if\s*\([^)]*\)\s*return;/);
    if (guard < 0) continue;
    allGuard.push(1);
    const before = body.slice(0, guard);
    const expectBefore = (before.match(/expect\s*\(/g) || []).length;
    const expectAfter = (body.match(/expect\s*\(/g) || []).length - expectBefore;
    if (expectBefore === 0 && expectAfter > 0) {
      vacuous.push({ file: relative(ROOT, f).split('\\').join('/'), title: s.title, expectAfter });
    }
  }
  // 注：不统计「整块零 expect」——多数用例经本地断言助手（如 expectReason）断言，
  // 直接按字面量统计会产生大量假阳性。只保留「guard 在断言之前」这一类。
}
console.log('含 guard 的用例数:', allGuard.length);
console.log('候选空洞（guard 前零 expect / 整块零 expect）:', vacuous.length);
for (const v of vacuous) console.log(`${v.file}  ::  ${v.title}  (之后 expect=${v.expectAfter})`);
