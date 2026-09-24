/**
 * Holds a long-running agent process the way a session does and prints its
 * pid, then waits — so a test can signal this process and see whether the
 * agent outlives it. The fake opencode server reads no stdin, so nothing but
 * spec-tacular's own clean-up would ever stop it.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { adopt } from '../../src/agent/children.ts';

const child = adopt(spawn(process.execPath, [join(import.meta.dir, 'fake-opencode.ts')], { stdio: ['ignore', 'pipe', 'ignore'] }));
child.stdout!.once('data', () => process.stdout.write(`${child.pid}\n`));
setInterval(() => {}, 1000);
