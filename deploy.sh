#!/usr/bin/env bash
# 工作间一键部署（零停机策略）。本机 git bash 执行：bash deploy.sh
# 策略：静态文件即时生效；caddy 配置走 validate + reload（热加载）；library 服务先健康后接流。
# 不重启 app 容器；如需重启 backend 改动，部署后手动 ssh 执行 docker compose restart app（秒级）。
set -euo pipefail
cd "$(dirname "$0")"
SERVER=lhins-bo5ohr73
PKG=/tmp/wb-deploy-$(date +%Y%m%d-%H%M%S).tgz

echo "== 打包（排除密钥/git/历史备份）=="
tar --exclude='.git' --exclude='app.env' --exclude='library.env' --exclude='backup-*' --exclude='_server.sha256' -czf "$PKG" .
ls -lh "$PKG"

echo "== 上传 =="
scp "$PKG" "$SERVER:/tmp/wb-deploy.tgz"

echo "== 远端部署 =="
ssh "$SERVER" 'bash -s' << 'REMOTE'
set -euo pipefail
cd /home/ubuntu
mkdir -p deploy-backups
tar -czf "deploy-backups/wb-$(date +%Y%m%d-%H%M%S).tgz" --exclude='backup-*' workbench-deploy 2>/dev/null || true
tar -xzf /tmp/wb-deploy.tgz -C workbench-deploy
cd workbench-deploy
# 1. library 服务先起并等健康（新容器，不影响线上）
docker compose up -d library
for i in $(seq 1 20); do
  st=$(docker inspect --format='{{.State.Health.Status}}' workbench-deploy-library-1 2>/dev/null || echo missing)
  [ "$st" = "healthy" ] && break
  sleep 2
done
echo "library 状态: $st"
# 2. Caddy 配置先校验，通过后热加载（失败则旧配置不动）
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
echo "== 部署完成 =="
REMOTE
echo "全部完成。验证：https://work.lhdreamcity.com/api/library/health 应返回 {\"ok\":true}"
