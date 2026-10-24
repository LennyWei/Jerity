#!/usr/bin/env bash
# deploy.sh: update the VM to the latest code and restart the game server.
# Run on the VM from the repo folder: ./deploy.sh   (first time: see deploy/README.md)
set -euo pipefail
cd "$(dirname "$0")"

git pull --ff-only
npm ci
npm run build
pm2 restart bumper --update-env || pm2 start npm --name bumper -- start
pm2 save
echo "deployed $(git rev-parse --short HEAD)"
