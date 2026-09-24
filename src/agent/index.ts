import { claudeDriver } from './claude.ts';
import { DriverRegistry } from './driver.ts';
import { opencodeDriver } from './opencode.ts';

export * from './driver.ts';
export { claudeDriver } from './claude.ts';
export { opencodeDriver } from './opencode.ts';

export const DEFAULT_DRIVER = 'claude';

export function defaultRegistry(): DriverRegistry {
  return new DriverRegistry().register(claudeDriver).register(opencodeDriver);
}
