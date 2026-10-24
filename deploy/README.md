# Deploying Bumper Brawl

iPhones only allow tilt over HTTPS, so the game runs on a VM behind Caddy (automatic HTTPS on a
free `sslip.io` name). Vercel can only host the static pages; it can't run the Socket.IO server.

**Anyone, after pushing:** `ssh` to the VM, `cd bumper && ./deploy.sh`, then post "deployed <commit>".

## First-time setup (Ubuntu VM, ports 80 and 443 open)

```bash
# Node 20, pm2, Caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git debian-keyring debian-archive-keyring apt-transport-https curl
sudo npm install -g pm2
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# The game
git clone https://github.com/LennyWei/HackPSUF26.git bumper && cd bumper
git checkout server/phase-a          # or main, once the server is merged
npm ci && npm run build
pm2 start npm --name bumper -- start  # until the real server is on the branch you deploy: -- run fake
pm2 save && pm2 startup               # run the command pm2 prints, so it survives reboots

# HTTPS: put your IP (dots as dashes) in deploy/Caddyfile, then
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Open `https://<ip-with-dashes>.sslip.io` on a phone. Check `https://…/health` returns `{ ok: true }`.

- Home, lobby, results: `/` · join link (the lobby QR): `/join/ABCD` · laptop view: `/spectate/ABCD`
- Logs: `pm2 logs bumper` · restart: `pm2 restart bumper`
- A page hosted elsewhere (Vercel) can still play: `https://your.vercel.app/?server=https://<ip>.sslip.io`
- Demo: every phone and the laptop on one teammate's hotspot, not venue Wi-Fi.
