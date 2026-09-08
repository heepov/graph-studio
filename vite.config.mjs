import { defineConfig } from 'vite';

// Сборка приложения. Ничего экзотического: один HTML-энтрипоинт, ассеты с хэшами.
// Просмотрщик (самодостаточный HTML только для чтения) собирается отдельным шагом —
// scripts/pack-viewer.mjs, он запускается после build и кладёт dist/viewer-template.html.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // читаемость важнее пары килобайт: приложение отлаживается прямо в браузере,
    // а исходник и так открыт под MIT
    minify: 'esbuild',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 8123, strictPort: false },
  preview: { port: 8124 },
});
