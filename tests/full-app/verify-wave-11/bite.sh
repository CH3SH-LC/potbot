#!/usr/bin/env bash
# FA-VERIFY-WAVE-11 · 咬合力（反向对照）自动化：把实现改坏 ⇒ 对应测试必须变红；改回来 ⇒ 恢复绿。
#
# 纪律：
#   - **只在本工作树内**改文件；每条突变跑完立刻 `git checkout -- <file>` 还原；
#   - 未跟踪的临时件（B9 的裸 NUL 文件）用 trap 兜底删除；
#   - 结束时断言工作树是干净的（`git status --porcelain` 只应剩下本工作包自己的新增文件）。
#
# 用法：bash tests/full-app/verify-wave-11/bite.sh
#
# 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。

set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"
TESTS="tests/full-app/verify-wave-11"
FAILED=0
declare -a LINES=()

restore() {
  git checkout -- apps/demo/server/session-host.ts apps/demo/documents/port.ts \
    apps/demo/server/adapters-actions.ts apps/demo/server/route-dispatch-scan.ts \
    apps/demo/server/roles-wiring.ts scripts/demo/honor-connect.mjs 2>/dev/null || true
  rm -f src/w11-bite-nul.ts src/w11-bite-nul.mjs 2>/dev/null || true
}
trap restore EXIT

# 精确替换（断言恰好命中 N 次），避免 sed 误伤同形片段。
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
  npx --no-install vitest run "$file" >/tmp/w11-bite.log 2>&1
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

echo "== FA-VERIFY-WAVE-11 咬合力测试（工作树：${ROOT}）=="

# B1 —— 产物 id 续版（T1①）：把 start_revision 退回常数 1（=修复前的形态）。
bite "B1" "session-host 恢复时 start_revision 退回 1 ⇒ T1① 应变红" red "$TESTS/T1-artifact-id-collision.test.ts" \
  mutate apps/demo/server/session-host.ts "start_revision: resumeRevisionOf(session)," "start_revision: asRevision(1)," 2

# B2 —— 端口"不覆盖"（T1 反向对照）：把盘上字节不符的判据关掉。
bite "B2" "端口 existing_mismatch 判据被关掉 ⇒ T1 反向对照应变红" red "$TESTS/T1-artifact-id-collision.test.ts" \
  mutate apps/demo/documents/port.ts "      if (digest !== expected) {" "      if (false) {" 1

# B3 —— 落点不再按 artifactId 区分（T1 对照）。
bite "B3" "落点忽略 artifactId ⇒ T1 对照（不同 id 互不影响）应变红" red "$TESTS/T1-artifact-id-collision.test.ts" \
  mutate apps/demo/documents/port.ts "join(this.#root, artifactId), 'artifactId');" "join(this.#root, 'A-fixed-bite'), 'artifactId');" 1

# B4 —— 取消失效动作（T2 正向）：**把修复退回缺陷形态**（取消不推进任务版本）⇒ 应变红。
#      `cancelTask` 的 `cancelledRevision` 一旦不推进，旧版本动作就不算过期 ⇒ 不失效。
bite "B4" "取消不推进任务版本（退回缺陷形态）⇒ T2 正向应变红" red "$TESTS/T2-cancel-invalidates-actions.test.ts" \
  mutate apps/demo/server/roles-wiring.ts \
  "      const cancelledRevision = nextRevision(task['revision'] as number as never);" \
  "      const cancelledRevision = task['revision'] as number as never;" 1

# B5 —— 未取消任务行为（T2 反向对照）：让 execute 一律 409。
bite "B5" "execute 一律 409 ⇒ T2 反向对照（未取消照常执行）应变红" red "$TESTS/T2-cancel-invalidates-actions.test.ts" \
  mutate apps/demo/server/adapters-actions.ts "if (isTerminalActionState(record.state)) {" "if (true) {" 1

# B6 —— CRLF shebang（T3）：把真脚本改成 CRLF。
crlf_the_script() {
  node -e '
    const fs = require("fs");
    const p = "scripts/demo/honor-connect.mjs";
    const text = fs.readFileSync(p, "utf8");
    fs.writeFileSync(p, text.replace(/\r?\n/g, "\r\n"));
    process.exit(text.includes("\r\n") ? 2 : 0);
  '
}
bite "B6" "honor-connect.mjs 改成 CRLF ⇒ T3 真文件断言应变红" red "$TESTS/T3-crlf-shebang.test.ts" \
  crlf_the_script

# B7 —— 派发守卫"现推"退化成手抄表（T4 自造新路由）。
bite "B7" "前缀表退化成手抄（排除新模块）⇒ T4 自造新路由应变红" red "$TESTS/T4-dispatch-guard-prefix.test.ts" \
  mutate apps/demo/server/route-dispatch-scan.ts "const modules = extractImportedModules(stripped);" "const modules = extractImportedModules(stripped).filter((entry) => entry.moduleFile !== 'w11-widget-routes.ts');" 1

# B8 —— 幽灵派发不再报红（T4 反向）。
bite "B8" "unownedDispatches 不再收集 ⇒ T4 幽灵路由应变红" red "$TESTS/T4-dispatch-guard-prefix.test.ts" \
  mutate apps/demo/server/route-dispatch-scan.ts "    if (rootsByModule.has(moduleFile) || (moduleSources.get(moduleFile) ?? null) === null) {" "    if (true) {" 1

# B9 —— 裸 NUL 守卫（T5）：往 src/ 放一个含真 0x00 的新源码文件。
add_nul_file() {
  node -e '
    const fs = require("fs");
    fs.writeFileSync("src/w11-bite-nul.ts", Buffer.concat([Buffer.from("const s = \"a"), Buffer.from([0]), Buffer.from("b\";")]));
  '
}
bite "B9" "往 src/ 放一个含裸 NUL 的 .ts ⇒ T5 全仓扫描应变红" red "$TESTS/T5-nul-bytes.test.ts" \
  add_nul_file

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
