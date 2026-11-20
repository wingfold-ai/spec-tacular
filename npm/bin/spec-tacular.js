#!/usr/bin/env node
// The `spec-tacular` command of the npm package @spec-tacular/cli.
//
// spec-tacular is a single compiled binary per platform. npm installs only the
// matching platform package (an optional dependency with `os` and `cpu`
// set), and this launcher finds its binary and runs it with the same
// arguments, terminal and exit code. It needs nothing but Node.
'use strict';

const { spawn } = require('node:child_process');
const { chmodSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

const PLATFORMS = {
  'linux-x64': '@spec-tacular/cli-linux-x64',
  'linux-arm64': '@spec-tacular/cli-linux-arm64',
  'darwin-x64': '@spec-tacular/cli-darwin-x64',
  'darwin-arm64': '@spec-tacular/cli-darwin-arm64',
};

function fail(message) {
  process.stderr.write(`spec-tacular: ${message}\n`);
  process.exit(1);
}

const platform = `${process.platform}-${process.arch}`;
const pkg = PLATFORMS[platform];
if (!pkg) {
  fail(
    `there is no build for ${platform}. spec-tacular runs on Linux and macOS, x64 and arm64.\n` +
      'Build it from source: https://spec-tacular.app/docs/getting-started/installation#build-from-source',
  );
}

let binary;
try {
  binary = join(dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'spec-tacular');
} catch {
  // The Linux builds need glibc; npm skips them on musl (Alpine).
  const glibc = process.platform !== 'linux' || Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
  if (!glibc) {
    fail(
      'the Linux builds need glibc, and this system uses musl (Alpine, for example).\n' +
        'Build it from source: https://spec-tacular.app/docs/getting-started/installation#build-from-source',
    );
  }
  fail(
    `the package ${pkg} with the binary for this platform is not installed.\n` +
      'npm skips it when optional dependencies are turned off (--omit=optional, or\n' +
      '--no-optional). Install again with optional dependencies:\n' +
      '  npm i -g @spec-tacular/cli',
  );
}

// Some installers drop the executable bit of files in a package.
try {
  if ((statSync(binary).mode & 0o111) === 0) chmodSync(binary, 0o755);
} catch {
  fail(`the binary ${binary} is missing. Install @spec-tacular/cli again.`);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });

// ctrl+c and ctrl+\ reach every process in the terminal, this one too. They
// are spec-tacular's to handle (it hands the terminal to an agent or an
// editor and keeps running), so the launcher must not die of them and leave
// the shell drawing over the TUI. A signal sent to the launcher alone goes on
// to spec-tacular.
for (const signal of ['SIGINT', 'SIGQUIT']) process.on(signal, () => {});
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('error', (err) => fail(err.message));
child.on('exit', (code, signal) => {
  if (signal) {
    // End the same way, so the shell sees what happened.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
