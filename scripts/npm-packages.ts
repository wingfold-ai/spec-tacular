#!/usr/bin/env bun
/**
 * Lays out the npm packages of a release from its platform builds.
 *
 *   bun scripts/npm-packages.ts --version 0.7.0 --builds <dir> --out <dir> [--partial]
 *
 * `--builds` holds one folder per platform, as the release archives unpack:
 * `spec-tacular-v0.7.0-linux-x64/` with the binary, LICENSE and
 * THIRD_PARTY_NOTICES.md. `--out` gets one folder per package, ready for
 * `npm publish`:
 *
 * - `@spec-tacular/cli-<os>-<cpu>`: one binary, with `os`, `cpu` (and `libc`
 *   on Linux) set so npm installs only the one that runs here;
 * - `@spec-tacular/cli`: the `spec-tacular` command, a small Node launcher
 *   (npm/bin/spec-tacular.js), with every platform package as an optional
 *   dependency at exactly this version.
 *
 * A release needs all four platforms; `--partial` lays out what is there, for
 * the CI check that installs the packages on one machine.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCOPE = '@spec-tacular';
const MAIN = `${SCOPE}/cli`;

/** npm's names for the platforms the release builds. */
export const PLATFORMS = [
  { id: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
  { id: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { id: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { id: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
] as const;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const version = option('--version') ?? die('--version is required, e.g. --version 0.7.0');
const builds = option('--builds') ?? die('--builds is required: the folder with the unpacked release archives');
const out = option('--out') ?? die('--out is required');
const partial = process.argv.includes('--partial');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`not a version: ${version}`);

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
// Trusted publishing checks repository.url against the workflow's repository.
const shared = {
  license: root['license'],
  author: root['author'],
  homepage: root['homepage'],
  repository: root['repository'],
  bugs: root['bugs'],
  publishConfig: { access: 'public' },
};

/** The unpacked folder of one platform, `spec-tacular-<tag>-<platform>`. */
function buildDir(platform: string): string | null {
  if (!existsSync(builds)) return null;
  const match = readdirSync(builds).find((d) => d.startsWith('spec-tacular-') && d.endsWith(`-${platform}`));
  return match ? join(builds, match) : null;
}

const write = (file: string, data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const laidOut: string[] = [];
for (const p of PLATFORMS) {
  const from = buildDir(p.id);
  if (!from) {
    if (partial) continue;
    die(`no build for ${p.id} in ${builds}: a release needs all four platforms`);
  }
  for (const file of ['spec-tacular', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!existsSync(join(from, file))) die(`${join(from, file)} is missing`);
  }
  const name = `${MAIN}-${p.id}`;
  const dir = join(out, `cli-${p.id}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(join(from, 'spec-tacular'), join(dir, 'bin', 'spec-tacular'));
  chmodSync(join(dir, 'bin', 'spec-tacular'), 0o755);
  copyFileSync(join(from, 'LICENSE'), join(dir, 'LICENSE'));
  copyFileSync(join(from, 'THIRD_PARTY_NOTICES.md'), join(dir, 'THIRD_PARTY_NOTICES.md'));
  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}\n\nThe spec-tacular binary for ${p.id}. Install [${MAIN}](https://www.npmjs.com/package/${MAIN}) instead; it picks this package on ${p.id}.\n\nThe binary embeds the Bun runtime and other packages; their licences are in THIRD_PARTY_NOTICES.md.\n`,
  );
  write(join(dir, 'package.json'), {
    name,
    version,
    description: `The spec-tacular binary for ${p.id}, installed by ${MAIN}.`,
    ...shared,
    os: [p.os],
    cpu: [p.cpu],
    ...('libc' in p ? { libc: [p.libc] } : {}),
    files: ['bin/spec-tacular', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'],
  });
  laidOut.push(name);
}
if (laidOut.length === 0) die(`no platform builds in ${builds}`);

const main = join(out, 'cli');
mkdirSync(join(main, 'bin'), { recursive: true });
copyFileSync(join(ROOT, 'npm', 'bin', 'spec-tacular.js'), join(main, 'bin', 'spec-tacular.js'));
chmodSync(join(main, 'bin', 'spec-tacular.js'), 0o755);
copyFileSync(join(ROOT, 'npm', 'README.md'), join(main, 'README.md'));
copyFileSync(join(ROOT, 'LICENSE'), join(main, 'LICENSE'));
write(join(main, 'package.json'), {
  name: MAIN,
  version,
  description: root['description'],
  ...shared,
  keywords: root['keywords'],
  bin: { 'spec-tacular': 'bin/spec-tacular.js' },
  files: ['bin/spec-tacular.js', 'LICENSE', 'README.md'],
  engines: { node: '>=18' },
  os: ['linux', 'darwin'],
  cpu: ['x64', 'arm64'],
  optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [`${MAIN}-${p.id}`, version])),
});

console.log(`Laid out ${MAIN} ${version} and ${laidOut.join(', ')} in ${out}`);
