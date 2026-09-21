/**
 * opencode driver.
 *
 * `opencode run <prompt>` is its non-interactive entry point. Its output is
 * already human-readable, so nothing is reinterpreted here.
 */

import { passthrough, type AgentCommand, type AgentDriver, type AgentRequest } from './driver.ts';

export const opencodeDriver: AgentDriver = {
  id: 'opencode',
  label: 'opencode',
  build(request: AgentRequest): AgentCommand {
    return { command: 'opencode', args: ['run', request.prompt] };
  },
  formatLine: passthrough,
};
