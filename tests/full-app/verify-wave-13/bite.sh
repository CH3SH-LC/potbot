#!/usr/bin/env bash
# FA-VERIFY-WAVE-13 · 咬合力（反向对照）自动化：把实现改坏 ⇒ 对应测试必须变红；改回来 ⇒ 恢复绿。
#
# 纪律（沿用 wave-11）：
#   - **只在本工作树内**改文件；每条突变跑完立刻 `git checkout -- <file>` 还原；
#   - 未跟踪的临时件（B10 的伪造路由文件）用 restore 兜底删除；
#   - 结束时断言工作树是干净的（`apps/ src/ scripts/` 无残留改动）。
#
# 用法：bash tests/full-app/verify-wave-13/bite.sh
#
# 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。

set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"
TESTS="tests/full-app/verify-wave-13"
FAILED=0
declare -a LINES=()

restore() {
  git checkout -- apps/demo/server/facts-routes.ts apps/demo/server/trace-fact-versions.ts \
    apps/demo/server/krn-orphans.ts apps/demo/server/session-adapters-wiring.ts \
    apps/demo/server/route-wiring.ts apps/demo/server/main.ts 2>/dev/null || true
  rm -f apps/demo/server/w13-bite-xls-print.ts 2>/dev/null || true
}
trap restore EXIT

# 精确替换（断言恰好命中 N 次），避免误伤同形片段。
mutate() {
  local file="$1" old="$2" new="$3" expect="${4:-1}"
  node -e '
    const fs = require("fs");
    const [file, old, nw, expect] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const count = text.split(old).length - 1;
    if (count !== Number(expect)) {
      console.error(`MUTATE-FAIL ${file}: 期望命中 ${expect} 次，实际 ${count} 次`);
      process.exit(2);
    }
    fs.writeFileSync(file, text.split(old).join(nw));
  ' "$file" "$old" "$new" "$expect" || return 1
}

run_test() {
  local file="$1"
  npx --no-install vitest run "$file" >/tmp/w13-bite.log 2>&1
  echo $?
}

bite() { # bite <编号> <说明> <期望: red|green> <测试文件> <突变命令...>
  local id="$1" desc="$2" expect="$3" file="$4"; shift 4
  echo "── ${id} ${desc}"
  if ! "$@"; then
    echo "   [SKIP] 突变无法施加（见上）"
    FAILED=1
    LINES+=("${id}|SKIP|${desc}")
    restore
    return
  fi
  local code
  code=$(run_test "$file")
  local got="green"
  [ "$code" -ne 0 ] && got="red"
  if [ "$got" = "$expect" ]; then
    echo "   [OK] 实测 ${got}（期望 ${expect}）"
    LINES+=("${id}|${got}|${desc}")
  else
    echo "   [BAD] 实测 ${got}（期望 ${expect}）"
    FAILED=1
    LINES+=("${id}|${got}(期望${expect})|${desc}")
  fi
  restore
}

echo "== FA-VERIFY-WAVE-13 咬合力测试（工作树：${ROOT}）=="

# B1 —— /api/facts 缺 expected_revision 的 400（T1 反例）。
bite "B1" "facts-routes 关掉 missing_expected_revision 判据 ⇒ T1 facts 反例应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/facts-routes.ts \
  "  if (!Object.prototype.hasOwnProperty.call(body, 'expected_revision')) {" \
  "  if (false) {" 1

# B2 —— /api/facts 版本冲突的 409（T1 反例）：退回"静默覆盖"形态。
bite "B2" "facts-routes 关掉 revision_conflict 判据 ⇒ T1 facts 反例应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/facts-routes.ts \
  "  if (expected !== chain.revision) {" \
  "  if (false) {" 1

# B3 —— 版本轨迹未知键的 404（T1 反例）：退回"200 + 空数组"形态。
bite "B3" "trace-fact-versions 未知键返回 200 空链 ⇒ T1 memory 反例应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/trace-fact-versions.ts \
  "  if (trace.versions.length === 0) {" \
  "  if (false) {" 1

# B4 —— 记忆隔离键（T1 反例）：不校验 owner_id。
bite "B4" "trace-fact-versions 不校验 owner_id ⇒ T1 memory 反例（缺 owner 400）应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/trace-fact-versions.ts \
  "  if (ownerRaw === null || !SAFE_ID.test(ownerRaw)) {" \
  "  if (false) {" 1

# B5 —— krn-orphans 未知子路径的 404（T1 反例）。
bite "B5" "krn-orphans 未知子路径改报 200 ⇒ T1 krn-orphans 反例应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/krn-orphans.ts \
  "      sendError(res, 404, 'unknown_krn_orphans_route'" \
  "      sendError(res, 200, 'unknown_krn_orphans_route'" 1

# B6 —— 预算未装配的结构化 503（T1 反例）：关掉闸门让它掉到 500。
bite "B6" "session-adapters 关掉 budget===null 的 503 ⇒ T1 session-adapters 反例应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/session-adapters-wiring.ts \
  "        if (budget === null) {" \
  "        if (false) {" 1

# B7 —— conversation-loop 未知子路径的 404（T1 反例）。
bite "B7" "route-wiring 未知 loop 子路径改报 200 ⇒ T1 conversation-loop 反例应变红" red "$TESTS/T1-endpoint-tristate.test.ts" \
  mutate apps/demo/server/route-wiring.ts \
  "      sendError(res, 404, 'unknown_loop_route'" \
  "      sendError(res, 200, 'unknown_loop_route'" 1

# B8 —— worker-loop 缺省执行器的"如实失败"（T2 M5 对照）：让它谎报成功。
#
# 注：执行器结算枚举是 `completed | failed | abandoned`（`src/scheduler/worker-loop.ts`）。
# 把 `failed` 改成**非枚举值** `succeeded` 是**无效突变**（`settle()` 落到 else 分支仍算 failed，
# 这点已在复核中实测）——必须改成合法的 `completed` 才是"谎报成功"。
bite "B8" "krn-orphans 缺省执行器改报 completed ⇒ T2 worker 诚实对照应变红" red "$TESTS/T2-product-mismatch.test.ts" \
  mutate apps/demo/server/krn-orphans.ts \
  "    execute: () => ({ status: 'failed' as const, reason: 'executor_unwired" \
  "    execute: () => ({ status: 'completed' as const, reason: 'executor_unwired" 1

# B9 —— main.ts 装配 adapters 时不注入执行器（T2 M5 静态判据）：加一个 executor 字段。
bite "B9" "main.ts 装配行里出现 executor 注入 ⇒ T2 M5 静态判据应变红" red "$TESTS/T2-product-mismatch.test.ts" \
  mutate apps/demo/server/main.ts \
  "  const adapters = createAdaptersHost({ store: host.store });" \
  "  const adapters = createAdaptersHost({ store: host.store, executor: undefined as never });" 1

# B10 —— /api/xls-print 静态扫描（T2 M1）：伪造一个含该前缀的路由文件。
add_xls_print_file() {
  node -e '
    const fs = require("fs");
    fs.writeFileSync("apps/demo/server/w13-bite-xls-print.ts", "export const ROOT = \"/api/xls-print\";\n");
  '
}
bite "B10" "往 apps/demo/server 放一个含 xls-print 的文件 ⇒ T2 M1 静态扫描应变红" red "$TESTS/T2-product-mismatch.test.ts" \
  add_xls_print_file

echo
echo "== 结果 =="
for line in "${LINES[@]}"; do echo "  ${line}"; done
echo
if [ -n "$(git status --porcelain -- apps src scripts 2>/dev/null)" ]; then
  echo "[BAD] 产品代码未完全还原："; git status --porcelain -- apps src scripts; FAILED=1
else
  echo "[OK] 产品代码已完全还原（apps/ src/ scripts/ 无改动）"
fi
[ "$FAILED" -eq 0 ] && echo "咬合力测试：全部符合预期" || echo "咬合力测试：存在不符合预期的项"
exit "$FAILED"
