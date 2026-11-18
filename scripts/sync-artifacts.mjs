import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.argv[2] ?? '');
const revision = '3cbf3f8d0c789dff0542ad8b412d088659423d06';
const paths = ['artifacts/asciimath.json', 'artifacts/asciimath.bindings.ts.json', 'artifacts/asciimath.checksums.txt', 'grammars/asciimath.parg', 'grammars/asciimath.wrappers.json', 'model/asciimath.lml.json', 'data/asciimath-symbols.json'];
const manifest = JSON.parse(await readFile(join(root, 'artifacts/manifest.json'), 'utf8'));
manifest.files = {};
for (const path of paths) {
  const bytes = execFileSync('git', ['-C', source, 'show', `${revision}:${path}`]);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  manifest.files[path] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(join(root, 'artifacts/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const digests = Object.fromEntries([['artifact', paths[0]], ['bindings', paths[1]], ['wrappers', paths[4]]].map(([key, path]) => [key, manifest.files[path]]));
await writeFile(join(root, 'src/pins.ts'), '// Generated from the pinned amath source manifest.\nexport const SOURCE_COMMIT = ' + JSON.stringify(revision) + ';\nexport const DIGESTS = ' + JSON.stringify(digests, null, 2) + ' as const;\n');
const data = JSON.parse(await readFile(join(root, 'data/asciimath-symbols.json'), 'utf8'));
const catalog = Object.fromEntries(data.symbols.map(row => [row.spelling, { value: row.value, kind: row.kind, ...(row.padded ? { padded: { value: row.padded.value, kind: row.padded.kind } } : {}) }]));
await writeFile(join(root, 'src/catalog.ts'), '// Generated from the pinned amath symbol catalog.\nexport const CATALOG: Readonly<Record<string, {value: string; kind: string; padded?: {value: string; kind: string}}>> = ' + JSON.stringify(catalog) + ';\n');
console.log(`synced ${paths.length} files from amath ${revision}`);
