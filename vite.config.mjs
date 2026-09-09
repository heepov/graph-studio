import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'node:fs';

// Отметка сборки: версия из package.json и короткий хеш коммита.
// Читаем .git напрямую, без git-бинарника — в образе его нет.
// Нужна, чтобы после деплоя можно было проверить, что на бою именно наш коммит,
// а не остался предыдущий образ: «деплой прошёл» само по себе этого не доказывает.
function gitSha() {
  try {
    if (!existsSync('.git/HEAD')) return 'dev';
    const head = readFileSync('.git/HEAD', 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = '.git/' + head.slice(5).trim();
      if (existsSync(ref)) return readFileSync(ref, 'utf8').trim().slice(0, 12);
      // упакованные ссылки
      if (existsSync('.git/packed-refs')) {
        const want = head.slice(5).trim();
        for (const line of readFileSync('.git/packed-refs', 'utf8').split('\n')) {
          const [sha, name] = line.split(' ');
          if (name === want) return sha.slice(0, 12);
        }
      }
      return 'dev';
    }
    return head.slice(0, 12);
  } catch { return 'dev'; }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const BUILD = {version: pkg.version, sha: gitSha()};

// Сборка приложения. Ничего экзотического: один HTML-энтрипоинт, ассеты с хэшами.
// Просмотрщик (самодостаточный HTML только для чтения) собирается отдельным шагом —
// scripts/pack-viewer.mjs, он запускается после build и кладёт dist/viewer-template.html.
export default defineConfig({
  base: '/',
  define: {__BUILD__: JSON.stringify(BUILD)},
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
