// The crate spike's line from the shell to the app (DWX-20): a Vite plugin,
// so it only exists while `tauri dev` serves the UI, never in a build.
//
// `scripts/crate-spike` posts a run to /__crate-spike/run. The plugin passes it
// to the app over Vite's hot-reload socket, waits for the app to post what it
// measured to /__crate-spike/result, and answers the run with it. Each result
// is also appended to .dev-data/crate-spike/results.jsonl.

import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The event the app listens for (src/crate-spike/remote.ts). */
export const RUN_EVENT = "crate-spike:run";

const RESULTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.dev-data/crate-spike/results.jsonl",
);

/** How long a run may take before the plugin gives up on the app. */
const TIMEOUT_MS = 180_000;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

export function crateSpike(): Plugin {
  const waiting = new Map<string, (result: unknown) => void>();
  let next = 1;

  return {
    name: "deadwax-crate-spike",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__crate-spike/run", async (req, res) => {
        const run = JSON.parse(await body(req)) as object;
        const id = String(next++);
        const timer = setTimeout(() => {
          waiting.delete(id);
          reply(res, 504, { error: "The app didn't answer. Is its window open and in front?" });
        }, TIMEOUT_MS);
        waiting.set(id, (result) => {
          clearTimeout(timer);
          reply(res, 200, result);
        });
        server.ws.send({ type: "custom", event: RUN_EVENT, data: { ...run, id } });
      });

      server.middlewares.use("/__crate-spike/result", async (req, res) => {
        const result = JSON.parse(await body(req)) as { id: string };
        mkdirSync(dirname(RESULTS), { recursive: true });
        appendFileSync(RESULTS, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
        waiting.get(result.id)?.(result);
        waiting.delete(result.id);
        reply(res, 200, { ok: true });
      });
    },
  };
}
