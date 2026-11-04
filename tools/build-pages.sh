#!/bin/sh
# build-pages.sh — 把真正需要托管的静态文件收进 dist/（无依赖、无打包器）
# 本地预览: sh tools/build-pages.sh && npx serve dist
# Cloudflare Pages: 构建命令 `sh tools/build-pages.sh`，输出目录 `dist`

set -eu
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist
cp index.html _headers dist/
cp -r css js dist/

echo "dist/ 就绪："
find dist -type f | wc -l | sed 's/^/  文件数: /'
du -sh dist | sed 's/^/  体积: /'
