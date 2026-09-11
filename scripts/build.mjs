/** Produces the deployment in Vercel's Build Output API layout:
 *
 *   .vercel/output/config.json
 *   .vercel/output/functions/api/chat.func/index.js      ← one CJS bundle
 *   .vercel/output/functions/api/chat.func/.vc-config.json
 *
 * Vercel runs this as the project's build command and deploys whatever it
 * finds under `.vercel/output`, skipping its own TypeScript builder — see
 * `src/vercel-entry.ts` for why that builder cannot load this route. The
 * bundle inlines the corpus (≈7 MB); Vercel's function limit is 250 MB. */
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.vercel', 'output');
const fn = join(output, 'functions', 'api', 'chat.func');

await rm(output, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'vercel-entry.ts')],
  outfile: join(fn, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

await writeFile(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 300,
      regions: ['gru1'],
    },
    null,
    2
  )
);

await writeFile(
  join(output, 'config.json'),
  JSON.stringify({ version: 3, routes: [{ handle: 'filesystem' }] }, null, 2)
);

console.log('built .vercel/output/functions/api/chat.func');
