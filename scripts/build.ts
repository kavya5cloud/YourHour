/**
 * Build the serverless functions.
 *
 * Why this exists: every module imports with an explicit `.ts` extension, which
 * is what Node's type stripping requires to run the sources directly in tests
 * and in `npm run dev`. Vercel's own TypeScript handling compiles the entry
 * point but leaves those specifiers alone, so the deployed function tries to
 * import `lib/http.ts` at runtime and dies with ERR_MODULE_NOT_FOUND.
 *
 * Bundling sidesteps the whole question. Each handler in `src-api/` becomes one
 * self-contained file in `api/` with no relative imports left to resolve, so
 * there is nothing for the platform to get wrong. `api/` is generated and
 * gitignored; `src-api/` is the source of truth.
 */
import { build } from 'esbuild';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src-api');
const OUT = join(ROOT, 'api');

/** Every .ts handler under src-api, recursively. */
async function entryPoints(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) found.push(...(await entryPoints(path)));
    else if (item.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const entries = await entryPoints(SRC);
await rm(OUT, { recursive: true, force: true });

for (const entry of entries) {
  const outfile = join(OUT, relative(SRC, entry).replace(/\.ts$/, '.js'));
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // `pg` ships native-ish internals and is a real dependency Vercel installs,
    // so leave it to be required at runtime rather than inlined.
    external: ['pg'],
    logLevel: 'warning',
  });
}

console.log(`Built ${entries.length} functions into api/`);
