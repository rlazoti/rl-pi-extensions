/** Drive the shipped factory/handlers with a temporary bank, without a model call.
 * This is not a Pi integration test; scripts/smoke-rpc.mjs covers the real runtime.
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";

/** Refuse flags a script does not read.
 *
 * A mistyped policy otherwise measures the default and prints it as though it were the
 * setting asked for — `--retrieval selective` on a script that only reads `--policy`.
 */
export function checkArgs(known) {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith("--") && !known.includes(a.slice(2)));
  if (unknown.length) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}\nAccepted: ${known.map((k) => `--${k}`).join(", ")}`);
    process.exit(1);
  }
}

export async function loadHarness(source, bank) {
  process.env.PI_MEMORY_DIR = bank;
  const jiti = createJiti(import.meta.url);
  const { default: extension } = await jiti.import(source);
  const handlers = new Map(), tools = new Map(), commands = new Map(), notices = [];
  const ctx = { cwd: process.cwd(), ui: { notify: (message, level) => notices.push({ message, level }) } };
  extension({ on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command) });
  return {
    handlers, tools, commands, notices, ctx,
    async start(config = {}, cwd = process.cwd()) {
      fs.writeFileSync(path.join(bank, "config.json"), JSON.stringify({ log: false, ...config }));
      ctx.cwd = cwd;
      await handlers.get("session_start")({ type: "session_start" }, ctx);
    },
    async inject(prompt) {
      return handlers.get("before_agent_start")({ type: "before_agent_start", messageType: "user", prompt, systemPrompt: "" }, ctx);
    },
  };
}
