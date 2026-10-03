#!/usr/bin/env bash
# FA-VERIFY-WAVE-14 · 咬合力（反向对照）自动化：把实现改坏 ⇒ 对应测试必须变红；改回 ⇒ 恢复绿。
#
# 纪律：
#   - **只在本工作树内**改文件；每条突变跑完立刻 `git checkout -- <file>` 还原；
#   - 结束时断言产品代码已完全还原（`git status --porcelain -- apps src` 为空）；
#   - 只跑**单个测试文件**（必要时再用 `-t` 收窄到单条用例），不跑全量 / 不跑 Gradle。
#
# 用法：bash tests/full-app/verify-wave-14/bite.sh
#
# 【T1 / T4 为什么没有"改坏实现"的咬合条】
#   - T1 判的是**版本库拓扑**（分支是否真在 main）。要造出"已宣布合并、实体不在 main"，
#     必须移动一个真实 `fa/*` 分支的 ref —— 而本仓**每一个 `fa/*` 分支都被一个活跃
#     worktree 检出**（`git worktree list` 可证），动它会影响别人的工作树。T1 的判别力
#     改由**文件内的合成反例**保证（见 T1 的两条"★反向对照"用例）。
#   - T4 判的是**提交信息 vs diff**（git 元数据），改产品源码不会影响它；它的判别力同样
#     由 §0 的合成反例保证（喂"声称 app-server 却只动 docs"的假 diff，必须报违规）。
#
# 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。

set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"
TESTS="tests/full-app/verify-wave-14"
T2="$TESTS/T2-structure-integrity.test.ts"
T3="$TESTS/T3-prefix-dispatch-crosscheck.test.ts"
T5="$TESTS/T5-guard-consistency.test.ts"
FAILED=0
declare -a LINES=()

restore() {
  git checkout -- apps/demo/server/http.ts apps/demo/server/main.ts \
    apps/demo/server/facts-routes.ts apps/demo/server/trace-fact-versions.ts 2>/dev/null || true
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

# 往文件末尾追加一段"坏结构"（孤儿 jsdoc 对 + 空壳块）。
append_broken_structure() {
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const snippet = [
      "",
      "/**",
      " * W14 咬合注入：孤儿 jsdoc 第一段。",
      " */",
      "/**",
      " * W14 咬合注入：孤儿 jsdoc 第二段（紧邻上一段，中间无声明）。",
      " */",
      "function w14BiteInjected(flag: boolean): void {",
      "  if (flag) {",
      "  }",
      "}",
      "",
    ].join("\n");
    fs.appendFileSync(p, snippet);
  ' "$1" || return 1
}

run_test() {
  local file="$1"; shift
  npx --no-install vitest run "$file" "$@" >/tmp/w14-bite.log 2>&1
  echo $?
}

bite() { # bite <编号> <说明> <期望: red|green> <测试文件> [--filter <名>] <突变命令...>
  local id="$1" desc="$2" expect="$3" file="$4"; shift 4
  local filter=()
  if [ "${1:-}" = "--filter" ]; then
    filter=(-t "$2"); shift 2
  fi
  echo "── ${id} ${desc}"
  if "$@"; then :; else
    echo "   [SKIP] 突变无法施加（见上）"
    FAILED=1
    LINES+=("${id}|SKIP|${desc}")
    restore
    return
  fi
  local code got
  if [ "${#filter[@]}" -gt 0 ]; then
    code=$(run_test "$file" "${filter[@]}")
  else
    code=$(run_test "$file")
  fi
  got="green"
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

echo "== FA-VERIFY-WAVE-14 咬合力测试（工作树：${ROOT}）=="

# B1 —— T2 §1：往 http.ts 注入"孤儿 jsdoc 对 + 空壳块" ⇒ http.ts 的结构断言应变红。
bite "B1" "http.ts 注入空壳块/孤儿 jsdoc ⇒ T2 http.ts 断言变红" red "$T2" \
  --filter "http.ts：" \
  append_broken_structure apps/demo/server/http.ts

# B2 —— T2 §1：往 main.ts 注入同样的坏结构 ⇒ main.ts 的结构断言应变红。
bite "B2" "main.ts 注入空壳块/孤儿 jsdoc ⇒ T2 main.ts 断言变红" red "$T2" \
  --filter "main.ts：" \
  append_broken_structure apps/demo/server/main.ts

# B3 —— T2 §2：往**另一个**路由模块注入坏结构 ⇒ 全量普查应变红（保证普查真有覆盖面）。
bite "B3" "facts-routes.ts 注入坏结构 ⇒ T2 全量普查变红" red "$T2" \
  --filter "全量无空壳块" \
  append_broken_structure apps/demo/server/facts-routes.ts

# B4 —— T2 §1：在 http.ts 里多插一个 `}` ⇒ 大括号不平衡 ⇒ 应变红。
bite "B4" "http.ts 多一个 } ⇒ T2 大括号平衡断言变红" red "$T2" \
  --filter "http.ts：" \
  mutate apps/demo/server/http.ts "  return (req, res): void => {" "  }\n  return (req, res): void => {" 1

# B5 —— T3：把 /api/xls-facts 的派发关掉 ⇒ 真服务上前缀落兜底 404 ⇒ 应变红。
bite "B5" "关掉 /api/xls-facts 派发 ⇒ T3 前缀交叉核对变红" red "$T3" \
  --filter "★核心" \
  mutate apps/demo/server/http.ts \
  "if (await handleXlsFactsRequest({ req, res, url, method }, xlsFactsHost)) {" "if (false) {" 1

# B6 —— T3：把 /api/facts 的派发关掉 ⇒ 应变红（不同前缀，证明不是只对一条敏感）。
bite "B6" "关掉 /api/facts 派发 ⇒ T3 前缀交叉核对变红" red "$T3" \
  --filter "★核心" \
  mutate apps/demo/server/http.ts \
  "if (await handleFactsRequest({ req, res, url, method }, factsHost)) {" "if (false) {" 1

# B7 —— T3：把 /api/roles 的派发关掉 ⇒ 应变红（接收者 `.handle(` 形态）。
bite "B7" "关掉 /api/roles 派发 ⇒ T3 前缀交叉核对变红" red "$T3" \
  --filter "★核心" \
  mutate apps/demo/server/http.ts \
  "if (rolesWiring !== null && (await rolesWiring.handle({ method, pathname, url, req, res }))) {" "if (false) {" 1

# B8 —— T5：把 trace-fact-versions 的嵌套 `*_ROOT` 从 `export const` 降为 `const`
#         ⇒ 守卫读不到它的前缀 ⇒ 报"无主" ⇒ "真实 http.ts 零报红"断言变红。
bite "B8" "trace-fact-versions 的 ROOT 不再 export ⇒ T5 '零报红'断言变红" red "$T5" \
  --filter "零报红" \
  mutate apps/demo/server/trace-fact-versions.ts \
  "export const FACT_VERSIONS_ROOT = '/api/memory/facts';" \
  "const FACT_VERSIONS_ROOT = '/api/memory/facts';" 1

# B9 —— T5：把 /api/ppt-facts 的派发关掉 ⇒ 守卫报 `mounted-prefix-not-dispatched`
#         ⇒ "真实 http.ts 零报红"断言变红（证明该断言不是恒真）。
bite "B9" "关掉 /api/ppt-facts 派发 ⇒ T5 '零报红'断言变红" red "$T5" \
  --filter "零报红" \
  mutate apps/demo/server/http.ts \
  "if (await handlePptxFactsRequest({ req, res, url })) {" "if (false) {" 1

# ---------------------------------------------------------------- 基线绿（对照组）
bite "G1" "（对照）未突变时 T2 全绿" green "$T2"
bite "G2" "（对照）未突变时 T5 全绿" green "$T5"

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
