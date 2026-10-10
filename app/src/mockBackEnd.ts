// The mocked Tauri back end UI tests run against (CLAUDE.md, "Code
// conventions"): never a real one.

import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";

export type Call = { cmd: string; args?: InvokeArgs };

/** A mocked back end: `replies` answers each command, and every call is logged. */
export function backEnd(
  replies: Record<string, (args?: InvokeArgs) => unknown>,
) {
  const calls: Call[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const reply = replies[cmd];
      if (!reply) throw new Error(`unexpected command ${cmd}`);
      return reply(args);
    },
    { shouldMockEvents: true },
  );
  return calls;
}
