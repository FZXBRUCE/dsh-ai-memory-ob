#!/usr/bin/env bash
# 一键推送到 GitHub。
# 用法:  ./publish.sh 你的GitHub用户名
#
# 做的事:
#   1. 检查工作区是否干净
#   2. 设置 remote(已有则改地址)
#   3. 把主分支命名为 main
#   4. 推送
set -euo pipefail

USER_NAME="${1:-}"
if [ -z "$USER_NAME" ]; then
  echo "用法: ./publish.sh 你的GitHub用户名"
  echo "例如: ./publish.sh octocat"
  exit 1
fi

REPO="dsh-ai-memory-ob"
URL="https://github.com/${USER_NAME}/${REPO}.git"

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交的改动:"
  git status --short
  echo ""
  read -r -p "要先提交吗? (y/n) " answer
  if [ "$answer" = "y" ]; then
    read -r -p "提交信息: " message
    git add -A
    git commit -m "${message:-chore: 更新}"
  else
    echo "已取消。先提交再推。"
    exit 1
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$URL"
  echo "✓ remote 已更新为 $URL"
else
  git remote add origin "$URL"
  echo "✓ remote 已设为 $URL"
fi

git branch -M main
echo "✓ 主分支: main"
echo ""
echo "开始推送……(第一次会弹浏览器要求登录 GitHub)"
git push -u origin main
echo ""
echo "✓ 完成: https://github.com/${USER_NAME}/${REPO}"
