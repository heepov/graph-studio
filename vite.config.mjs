import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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

// Просмотрщик встраивает бандл внутрь <script type="module">, и литерал закрывающего
// тега в коде оборвал бы блок посередине. Раньше его экранировал esbuild; минификатор
// Vite 8 этого не делает, а React несёт такие литералы в себе. Экранируем в готовых
// чанках: «<\/script» внутри строки и регулярки означает то же самое, что «</script».
// Гард в pack-viewer.mjs НЕ ослабляется — он остаётся последней проверкой.
const escapeScriptClose = () => ({
  name: 'escape-script-close',
  renderChunk(code) {
    return code.includes('</script') ? {code: code.split('</script').join('<\\/script'), map: null} : null;
  },
});

// Сборка приложения. Ничего экзотического: один HTML-энтрипоинт, ассеты с хэшами.
// Просмотрщик (самодостаточный HTML только для чтения) собирается отдельным шагом —
// scripts/pack-viewer.mjs, он запускается после build и кладёт dist/viewer-template.html.
//
// React нужен только странице «Конструктор» (src/flow). Он в основном бандле, а не
// ленивым чанком: просмотрщик встраивает лишь точку входа, и ленивый чанк в файле,
// открытом офлайн, просто не загрузится.
export default defineConfig({
  base: '/',
  plugins: [react(), escapeScriptClose()],
  define: {__BUILD__: JSON.stringify(BUILD)},
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // читаемость важнее пары килобайт: приложение отлаживается прямо в браузере,
    // а исходник и так открыт под MIT. Минификатор — штатный oxc из Vite 8:
    // esbuild в нём стал необязательной зависимостью.
    minify: true,
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
