#!/usr/bin/env bun
/**
 * Builds `spectacular` as a standalone executable: the Bun runtime, the
 * program and OpenTUI's native library in one file, so the machine it runs on
 * needs neither Bun nor node_modules.
 *
 *   bun run build                                  dist/spectacular for this machine
 *   bun run build --target bun-darwin-arm64        another platform
 *   bun run build --outfile /tmp/spectacular
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
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const target = option('--target');
const outfile = option('--outfile') ?? join('dist', 'spectacular');

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
