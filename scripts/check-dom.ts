/**
 * Check that every element `app.js` reaches for exists in `index.html`.
 *
 * The markup has been rewritten several times, and each rewrite risks leaving
 * the client reaching for an element that no longer exists. That is invisible
 * to a typecheck -- the client is plain JavaScript -- and fails only when a
 * visitor clicks something, which is a poor time to find out.
 *
 * Deliberately just this one check. A broader "is every identifier declared"
 * pass was tried and produced dozens of false positives from words inside
 * comments and strings; a check people learn to ignore is worse than no check.
 */
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const js = await readFile(`${root}public/app.js`, 'utf8');
const html = await readFile(`${root}public/index.html`, 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]!));

const missing = [...used].filter((id) => !htmlIds.has(id)).sort();
if (missing.length > 0) {
  for (const id of missing) console.error(`  app.js reaches for #${id}, which is not in index.html`);
  process.exit(1);
}
console.log(`app.js and index.html agree (${used.size} ids checked).`);
