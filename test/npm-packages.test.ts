import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'npm-packages.ts');
const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Unpacked release archives, as the release job has them, for these platforms. */
function builds(platforms: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-npm-'));
  dirs.push(root);
  for (const p of platforms) {
    const dir = join(root, 'builds', `spec-tacular-v1.2.3-${p}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec-tacular'), `binary for ${p}`);
    writeFileSync(join(dir, 'LICENSE'), 'MIT');
    writeFileSync(join(dir, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices');
  }
  return root;
}

function layOut(root: string, ...extra: string[]) {
  const out = join(root, 'out');
  const run = spawnSync('bun', [SCRIPT, '--version', '1.2.3', '--builds', join(root, 'builds'), '--out', out, ...extra], {
    encoding: 'utf8',
  });
  return { out, status: run.status, stderr: run.stderr };
}

const pkg = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

describe('the npm packages of a release', () => {
  test('one package per platform, and the command with all four as optional dependencies', () => {
    const { out, status } = layOut(builds(PLATFORMS));
    expect(status).toBe(0);

    const main = pkg(join(out, 'cli'));
    expect(main.name).toBe('@spec-tacular/cli');
    expect(main.version).toBe('1.2.3');
    expect(main.bin).toEqual({ 'spec-tacular': 'bin/spec-tacular.js' });
    expect(main.optionalDependencies).toEqual({
      '@spec-tacular/cli-linux-x64': '1.2.3',
      '@spec-tacular/cli-linux-arm64': '1.2.3',
      '@spec-tacular/cli-darwin-x64': '1.2.3',
      '@spec-tacular/cli-darwin-arm64': '1.2.3',
    });
    // npm's trusted publishing matches repository.url against the workflow's repository.
    expect(main.repository.url).toBe('git+https://github.com/wingfold-ai/spec-tacular.git');
    expect(main.publishConfig).toEqual({ access: 'public' });
    expect(statSync(join(out, 'cli', 'bin', 'spec-tacular.js')).mode & 0o111).not.toBe(0);

    const linux = pkg(join(out, 'cli-linux-arm64'));
    expect(linux).toMatchObject({ name: '@spec-tacular/cli-linux-arm64', os: ['linux'], cpu: ['arm64'], libc: ['glibc'] });
    const mac = pkg(join(out, 'cli-darwin-x64'));
    expect(mac).toMatchObject({ os: ['darwin'], cpu: ['x64'] });
    expect(mac.libc).toBeUndefined();

    const binary = join(out, 'cli-darwin-x64', 'bin', 'spec-tacular');
    expect(readFileSync(binary, 'utf8')).toBe('binary for darwin-x64');
    expect(statSync(binary).mode & 0o111).not.toBe(0);
    expect(existsSync(join(out, 'cli-darwin-x64', 'THIRD_PARTY_NOTICES.md'))).toBe(true);
  });

  test('a release refuses to go out with a platform missing', () => {
    const { status, stderr } = layOut(builds(['linux-x64']));
    expect(status).toBe(1);
    expect(stderr).toContain('a release needs all four platforms');
  });

  test('--partial lays out what is there, for the install check on one machine', () => {
    const { out, status } = layOut(builds(['linux-x64']), '--partial');
    expect(status).toBe(0);
    expect(existsSync(join(out, 'cli-linux-x64'))).toBe(true);
    expect(existsSync(join(out, 'cli-darwin-arm64'))).toBe(false);
    expect(Object.keys(pkg(join(out, 'cli')).optionalDependencies)).toHaveLength(4);
  });

  test('a build without its licence notices is refused', () => {
    const root = builds(['linux-x64']);
    rmSync(join(root, 'builds', 'spec-tacular-v1.2.3-linux-x64', 'THIRD_PARTY_NOTICES.md'));
    const { status, stderr } = layOut(root, '--partial');
    expect(status).toBe(1);
    expect(stderr).toContain('THIRD_PARTY_NOTICES.md is missing');
  });
});
