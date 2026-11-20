// Bundles server.ts into dist/server.cjs for production.
// Uses the esbuild JS API so the NODE_ENV define avoids shell-quoting issues on Windows.
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  sourcemap: true,
  outfile: join(root, 'dist', 'server.cjs'),
  // The generated Prisma client reads import.meta.url, which esbuild empties in
  // CJS output; supply the bundle's own file URL so it does not throw on load.
  banner: {
    js: 'const __import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    // Fold the dev branch (vite middleware) out of the production bundle.
    'process.env.NODE_ENV': '"production"',
    'import.meta.url': '__import_meta_url',
  },
});

console.log('Bundled dist/server.cjs (production)');
