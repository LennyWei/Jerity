// client/vite.config.js
// Dev: `npm run dev:client` serves /client with HMR and proxies Socket.IO to the game server on :3000.
// Phones: `npm run dev:phone` serves HTTPS with a self-signed cert, because phone
// browsers only give motion sensors to secure pages. Accept the warning once per phone.
// Build: `npm run build` writes client/dist, which the server serves.
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  root: here,
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: {
    host: true,                                // phones on the same Wi-Fi can open it
    fs: { allow: [resolve(here, '..')] },      // client imports ../shared
    proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true } },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        gameDev: resolve(here, 'game-dev.html'),
        snapView: resolve(here, 'snap-view.html'),
        playDev: resolve(here, 'play-dev.html'),
      },
    },
  },
}));
