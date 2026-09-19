#!/usr/bin/env bash
#
# push-to-github.sh — 在「可联网机器」上执行，把沙箱打出的 git bundle 推送到 GitHub。
#
# 前置：
#   1) 沙箱里已执行 `git bundle create chainvote.bundle --all`（见下方"沙箱侧"）
#   2) 已把 chainvote.bundle 拷到本机（与脚本同目录，或用第 2 个参数指定路径）
#   3) 已在 GitHub 上建好空仓库，拿到 <REMOTE_URL>
#
# 用法：
#   ./scripts/push-to-github.sh <REMOTE_URL> [BUNDLE_PATH]
#   例：./scripts/push-to-github.sh https://github.com/<你>/chainvote.git
#
set -euo pipefail

REMOTE_URL="${1:?用法: push-to-github.sh <REMOTE_URL> [BUNDLE_PATH]}"
BUNDLE="${2:-chainvote.bundle}"

if [ ! -f "$BUNDLE" ]; then
  echo "::error::找不到 bundle 文件: $BUNDLE" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
echo ">> 从 bundle 克隆到临时目录: $WORKDIR"
git clone "$BUNDLE" "$WORKDIR/repo" >/dev/null
cd "$WORKDIR/repo"

echo ">> 当前分支: $(git branch --show-current)"
echo ">> 提交数: $(git rev-list --count HEAD)"

echo ">> 添加远端: $REMOTE_URL"
git remote add origin "$REMOTE_URL"

echo ">> 推送所有分支与标签"
git push -u origin --all --tags

echo ""
echo ">> 完成。请到 GitHub 仓库的 Actions 标签页确认："
echo "   - build-and-test 任务（编译/测试/覆盖率/体积/gas）"
echo "   - slither 任务（High/Medium 未处理则失败）"
echo "   - secret-scan 任务（硬约束：禁止提交 .env 与硬编码私钥）"
echo "   临时克隆目录: $WORKDIR （可手动删除）"
