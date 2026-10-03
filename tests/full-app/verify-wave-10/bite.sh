#!/usr/bin/env bash
# FA-VERIFY-WAVE-10 · 第 6 项 —— 反向对照**咬合力**实测（≥8 条）。
#
# 做法：在**本工作树内**把被对照的实现**改坏**（按行号 sed / 注入字节），跑本轮那条测试，
# 记 RED / GREEN，**立刻 `git checkout --` 还原**。跑完后源码必须干净（末尾打印 git status）。
#
# 判读：
#   RED   = 该测试**咬得住**这个实现缺陷（真判据）；
#   GREEN = 改坏实现它仍全绿 ⇒ **不咬人**（弱判据 / 判据不在那一层）。
#
# 【模型身份】子智能体模型身份未确认为 DS。
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"
echo "bite root = $ROOT"
W10="tests/full-app/verify-wave-10"

run_case() {
  local id="$1"; shift
  local file="$1"; shift
  local sedexpr="$1"; shift
  local cmd="$1"; shift
  echo "----------------------------------------------------------------"
  echo "[$id] mutate $file :: $sedexpr"
  sed -i "$sedexpr" "$file"
  if git diff --quiet -- "$file"; then echo "  !! mutation produced no diff"; fi
  # shellcheck disable=SC2086
  out="$(eval "$cmd" 2>&1)"
  code=$?
  local summary
  summary="$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests +[0-9]+ (failed|passed)|Test Files +[0-9]+ (failed|passed)" | tr '\n' ' ')"
  if [ $code -eq 0 ]; then
    echo "  RESULT = GREEN (没咬住)  ${summary}"
  else
    echo "  RESULT = RED   (咬得住)  ${summary}"
  fi
  git checkout -- "$file"
  if ! git diff --quiet -- "$file"; then echo "  !! REVERT FAILED for $file"; fi
}

VITEST="npx --no-install vitest run"

# ---- P0 可信回执 -----------------------------------------------------------
# B1 客户端自报的 trusted 被重新采信（复原修复前的缺陷形态）
run_case B1 apps/demo/server/adapters-actions.ts \
  '711s|.*|            trusted: true,|' \
  "$VITEST $W10/T1-trusted-receipt.test.ts"

# B2 一次性令牌的"已用"检查被摘掉 ⇒ 重放不再被拒
run_case B2 apps/demo/server/adapters-actions.ts \
  '447s|.*|    if (false) {|' \
  "$VITEST $W10/T1-trusted-receipt.test.ts"

# B3 合法令牌不再被认 ⇒ 受控执行器路径失效
run_case B3 apps/demo/server/adapters-actions.ts \
  '700s|.*|        if (false) {|' \
  "$VITEST $W10/T1-trusted-receipt.test.ts"

# ---- 主聊天两断点 ---------------------------------------------------------
# B4 起轮次被拒后仍进工具循环（复原"没有主人的产物"缺陷）
run_case B4 apps/demo/server/conversation-host.ts \
  '707s|.*|    if (false) {|' \
  "$VITEST $W10/T2-chat-breakpoints.test.ts"

# B5 重试复用同一尝试序号（撞 duplicate，结局无处可写）
run_case B5 apps/demo/server/conversation-host.ts \
  '616s|.*|      attempt: 0,|' \
  "$VITEST $W10/T2-chat-breakpoints.test.ts"

# B6 当前文档不再落盘（关联只活在内存里）
run_case B6 apps/demo/server/conversation-host.ts \
  '1331s|.*|    // mutated: persist disabled|' \
  "$VITEST $W10/T2-chat-breakpoints.test.ts"

# ---- 预算 -----------------------------------------------------------------
# B7 记账量改由客户端自报的值决定（硬限制受被限制方控制）
run_case B7 apps/demo/server/budget-wiring.ts \
  '416s|.*|    charges[dimension] = Number(declared[dimension]);|' \
  "$VITEST $W10/T3-budget.test.ts"

# B8 没有 key 就不落盘（额度跨重启回升）
run_case B8 apps/demo/server/budget-wiring.ts \
  '544s|.*|        if (amount === undefined \|\| amount === 0 \|\| request.key === undefined) {|' \
  "$VITEST $W10/T3-budget.test.ts"

# ---- 派发守卫 -------------------------------------------------------------
# B9 手抄表里塞进自造前缀 ⇒ 段一"新前缀一条报红都没有"的判据必须变红
run_case B9 apps/demo/server/route-dispatch-scan.ts \
  "268s|.*|    prefix: '/api/widgets',|" \
  "$VITEST $W10/T5-dispatch-guard.test.ts"

# ---- 裸 NUL 守卫 ----------------------------------------------------------
# B10 往一个真实源码文件尾部注入**真 0x00 字节** ⇒ 扫描必须变红
echo "----------------------------------------------------------------"
echo "[B10] inject real NUL byte into src/protocol/membership.ts"
printf '\0' >> src/protocol/membership.ts
if git diff --quiet -- src/protocol/membership.ts; then echo "  !! mutation produced no diff"; fi
out="$(eval "$VITEST $W10/T4-nul-guard.test.ts" 2>&1)"
code=$?
summary="$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests +[0-9]+ (failed|passed)|Test Files +[0-9]+ (failed|passed)" | tr '\n' ' ')"
if [ $code -eq 0 ]; then
  echo "  RESULT = GREEN (没咬住)  ${summary}"
else
  echo "  RESULT = RED   (咬得住)  ${summary}"
fi
git checkout -- src/protocol/membership.ts
if ! git diff --quiet -- src/protocol/membership.ts; then echo "  !! REVERT FAILED for src/protocol/membership.ts"; fi

echo "=================================================================="
echo "收尾 git status（源码应无残留）："
git status --porcelain
