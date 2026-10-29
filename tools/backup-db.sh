#!/usr/bin/env bash
# SQLite 定时备份的宿主包装：在一次性容器里跑 tools/backup-db.mjs。
# 主机不需要装 node —— 库服务本身也跑在容器里，备份跟它用同一套运行环境。
#
# 为什么用 docker run 而不是 docker compose run：
#   compose 里 library 服务是 user 1000:1001 + read_only + cap_drop ALL，
#   compose run 会继承这些约束；这里要的是「以 root 读写 app_data 卷、
#   只读挂代码目录」，用普通 docker run 才是干净写法。
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VOLUME=workbench-deploy_app_data
IMAGE=node:24-bookworm

docker run --rm \
  -v "${VOLUME}:/data" \
  -v "${DEPLOY_DIR}:/app:ro" \
  --env-file "${DEPLOY_DIR}/library.env" \
  -e DB_PATH=/data/workroom.sqlite \
  -e BACKUP_DIR=/data/backups \
  "${IMAGE}" \
  node /app/tools/backup-db.mjs
