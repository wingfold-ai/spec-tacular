#!/usr/bin/env bun
/**
 * Builds `spec-tacular` as a standalone executable: the Bun runtime, the
 * program and OpenTUI's native library in one file, so the machine it runs on
 * needs neither Bun nor node_modules.
 *
 *   bun run build                                  dist/spec-tacular for this machine
 *   bun run build --target bun-darwin-arm64        another platform
 *   bun run build --outfile /tmp/spec-tacular
 *
 * bunfig.toml's preload does not apply to `bun build`, so the Solid JSX
 * transform is passed here as a plugin; without it the TUI renders once and
 * never updates.
 *
 * OpenTUI loads its native library from a per-platform package
 * (@opentui/core-<os>-<arch>) that `bun install` only fetches for the machine
 * it runs on. The bundler embeds whichever of those is installed and quietly
 * skips the rest, so building for another platform would produce a binary
 * that fails at start-up. The build refuses that instead.
 */

import solidPlugin from '@opentui/solid/bun-plugin';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const target = option('--target');
const outfile = option('--outfile') ?? join('dist', 'spec-tacular');

/** `bun-darwin-x64-baseline` → `darwin-x64`; no target means this machine. */
function platformOf(target: string | undefined): string {
  if (!target) return `${process.platform}-${process.arch}`;
  const match = /^bun-(linux|darwin|windows)-(x64|arm64)/.exec(target);
  if (!match) throw new Error(`Unrecognised --target ${target}`);
  const os = match[1] === 'windows' ? 'win32' : match[1];
  return `${os}-${match[2]}`;
}

const nativePackage = `@opentui/core-${platformOf(target)}`;
if (!existsSync(join('node_modules', nativePackage))) {
  process.stderr.write(
    `${nativePackage} is not installed, so the binary would start without OpenTUI's\n` +
      `native library. Build on that platform, or install the package first.\n`,
  );
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: ['./src/cli.ts'],
  target: 'bun',
  plugins: [solidPlugin],
  minify: true,
  // Which packages end up in the binary, for THIRD_PARTY_NOTICES.md.
  metafile: true,
  // Embedded in the binary, so stack traces name source files and lines.
  sourcemap: 'inline',
  compile: {
    outfile,
    // A compiled binary would otherwise read bunfig.toml, .env, tsconfig.json
    // and package.json from whatever folder it is started in — the user's
    // project, not ours. A bunfig preload there breaks start-up, and a .env
    // would leak into the environment the agents inherit.
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
    ...(target ? { target: target as Bun.Build.CompileTarget } : {}),
  },
});

for (const log of result.logs) console.error(log);
if (!result.success) process.exit(1);
console.log(`Built ${outfile}${target ? ` for ${target}` : ''}`);

/**
 * The binary carries the Bun runtime and every package the bundler pulled in,
 * so it ships their licences: THIRD_PARTY_NOTICES.md next to it, with every
 * licence file each package has (OpenTUI's native library brings several,
 * FFmpeg's LGPL among them), and Bun's own notice, which covers what Bun
 * links (JavaScriptCore under the LGPL, among others).
 */
function bundledPackages(inputs: string[]): string[] {
  const names = new Set<string>();
  for (const input of inputs) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

function licenceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

const inputs = Object.keys(result.metafile?.inputs ?? {});
const packages = bundledPackages(inputs);
if (packages.length === 0) {
  process.stderr.write('The build reported no bundled packages; cannot write THIRD_PARTY_NOTICES.md.\n');
  process.exit(1);
}
const notices: string[] = [
  '# Third-party notices',
  '',
  'spec-tacular is MIT-licensed (see LICENSE). This binary also contains the',
  'software below, under its own licences.',
  '',
  '## Bun',
  '',
  `The Bun runtime ${Bun.version} (https://bun.sh), embedded by \`bun build --compile\`.`,
  '',
  // Bun's LICENSE.md (scripts/licenses/bun.md), a level down under this heading.
  readFileSync(join(import.meta.dir, 'licenses', 'bun.md'), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '').trim().replace(/^(#+) /gm, '#$1 '),
  '',
];
for (const name of packages) {
  const dir = join('node_modules', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version: string;
    license?: string;
    homepage?: string;
    repository?: string | { url?: string };
  };
  const source = pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? '';
  const files = licenceFiles(dir);
  if (files.length === 0) {
    process.stderr.write(`${name} has no licence file to include in THIRD_PARTY_NOTICES.md.\n`);
    process.exit(1);
  }
  notices.push(`## ${name} ${pkg.version}`, '', `License: ${pkg.license ?? 'see below'}${source ? ` · ${source}` : ''}`, '');
  for (const file of files) {
    notices.push(`### ${file}`, '', '```text', readFileSync(join(dir, file), 'utf8').trim(), '```', '');
  }
}
const noticesFile = join(dirname(outfile), 'THIRD_PARTY_NOTICES.md');
writeFileSync(noticesFile, notices.join('\n'));
console.log(`Wrote ${noticesFile} (${packages.length} packages and Bun)`);
