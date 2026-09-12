import { defineConfig } from 'vite';

// 개발 시(vite dev)에는 실서버(9420)로 프록시한다.
// 빌드 산출물(dist)은 api 프로세스가 루트에서 직접 서빙한다.
const devServer = process.env['WALLET_DEV_SERVER'] ?? 'http://127.0.0.1:9420';

export default defineConfig({
  base: './',
  server: {
    proxy: {
      '/login': devServer,
      '/vault': devServer,
      '/health': devServer,
      '/admin': devServer,
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
