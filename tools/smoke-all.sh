#!/bin/sh
# 依次运行全部冒烟测试，任一失败即退出非零（CI 与本地通用）
set -u
cd "$(dirname "$0")/.."

fails=0
for f in tools/smoke.mjs tools/tutorial-smoke.mjs tools/airfield-smoke.mjs \
         tools/ui-smoke.mjs tools/flight-smoke.mjs tools/mission-smoke.mjs; do
  printf '\n### %s\n' "$f"
  if ! node "$f" > "$(mktemp)" 2>&1; then
    # 失败时重跑一次以显示完整输出
    node "$f" || true
    fails=$((fails + 1))
    printf '  ✗ 失败: %s\n' "$f"
  else
    printf '  ✓ 通过\n'
  fi
done

if [ "$fails" -ne 0 ]; then
  printf '\n✗ %d 项冒烟测试失败\n' "$fails"
  exit 1
fi
printf '\n✅ 全部冒烟测试通过\n'
