import { defineConfig } from 'vite';

// GitHub Pages はサブパス (/camsim/) で配信されるため相対パスでビルドする
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
