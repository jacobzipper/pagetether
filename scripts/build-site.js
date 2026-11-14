// Assemble the static site: site/ plus the library modules it imports, in one
// directory that can be served from any path (GitHub Pages, a file server).
//
//   node scripts/build-site.js [outDir]     default: _site
//
// The site sources import the library as ../src/*.js so they run straight from
// the repository; the build copies src/ to lib/ and points the imports there.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? join(root, '_site'));
if (out === resolve(root) || resolve(root).startsWith(out + '/')) {
  throw new Error(`refusing to build into ${out}`);
}

// Only what the browser needs: the Node bindings stay out.
const LIB = ['core.js', 'tether.js', 'web.js', 'client.js', 'probes.js'];

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'lib'), { recursive: true });

for (const name of await readdir(join(root, 'site'))) {
  const from = join(root, 'site', name);
  if (!name.endsWith('.js')) {
    await cp(from, join(out, name), { recursive: true });
    continue;
  }
  const source = await readFile(from, 'utf8');
  const rewritten = source.replaceAll("from '../src/", "from './lib/");
  if (rewritten.includes('../src/')) throw new Error(`${name}: an import of ../src/ was not rewritten`);
  await writeFile(join(out, name), rewritten);
}
for (const name of LIB) await cp(join(root, 'src', name), join(out, 'lib', name));

// Tell GitHub Pages to serve the files as they are.
await writeFile(join(out, '.nojekyll'), '');
console.log(`site built in ${out}`);
