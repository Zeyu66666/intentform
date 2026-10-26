#!/usr/bin/env bash
# 逐个 commit 在干净 worktree 中单独验证 typecheck（评审硬检查项）。
set -u
cd "$(dirname "$0")/.." || exit 1
base=34a18c6
commits=$(git rev-list --reverse "$base..HEAD")
fail=0
for c in $commits; do
  short=$(git log -1 --format=%h "$c")
  subject=$(git log -1 --format=%s "$c")
  wt=".verify-worktrees/$short"
  rm -rf "$wt"
  git worktree add -q --detach "$wt" "$c" 2>/dev/null || { echo "FAIL worktree $short"; fail=1; continue; }
  if (cd "$wt" && pnpm install --frozen-lockfile --ignore-scripts >/tmp/inst-$short.log 2>&1 && pnpm typecheck >/tmp/tc-$short.log 2>&1); then
    echo "OK   $short  $subject"
  else
    echo "FAIL $short  $subject"
    tail -5 "/tmp/tc-$short.log" 2>/dev/null
    tail -5 "/tmp/inst-$short.log" 2>/dev/null
    fail=1
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1
done
git worktree prune
rmdir .verify-worktrees 2>/dev/null
echo "---- 结果：$( [ $fail -eq 0 ] && echo '全部通过' || echo '有失败' )"
exit $fail
