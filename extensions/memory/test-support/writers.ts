/**
 * Two processes, one bank: the concurrency tests' only honest tool.
 *
 * A lock cannot be proven by calling the writer twice in one process — synchronous
 * code cannot interleave. These helpers spawn real child processes that do the same
 * write at the same time, so a lost update fails the test rather than hiding in a
 * code-reading argument.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REGISTER = resolve(HERE, "../../../test-support/register.mjs");

const SCRIPTS: Record<string, string> = {
	store: `
		const { bankPaths, upsertClaim } = await import(SOURCES.store);
		const paths = bankPaths(BANK);
		const who = process.argv[2];
		for (let i = 0; i < 6; i++) {
			upsertClaim(paths, {
				key: "git." + who + i, kind: "rule", scope: "global", asOf: "2026-01-01",
				source: "concurrency test", body: "Claim " + who + i,
				aliases: [], tags: [], links: [], origin: "agent", state: "approved",
			});
		}
	`,
	daily: `
		const { bankPaths } = await import(SOURCES.store);
		const { appendDailyItem } = await import(SOURCES.daily);
		const paths = bankPaths(BANK);
		const who = process.argv[2];
		for (let i = 0; i < 6; i++) {
			appendDailyItem(paths, { section: "note", text: "item " + who + " " + i, clock: () => new Date("2026-10-18T10:00:00") });
		}
	`,
};

export interface WriterResult {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Run `kind` once per name, all processes started together, against one bank
 * directory. They are started at the same moment on purpose: the point is the
 * window in which two sessions hold the same read.
 */
export async function parallelWriters(bankDir: string, kind: "store" | "daily", who: string[]): Promise<WriterResult[]> {
	const scriptFile = join(mkdtempSync(join(tmpdir(), "memory-writers-")), "writer.mjs");
	writeFileSync(
		scriptFile,
		`const BANK = ${JSON.stringify(bankDir)};\nconst SOURCES = ${JSON.stringify({ store: join(HERE, "../store.ts"), daily: join(HERE, "../daily.ts") })};\n${SCRIPTS[kind]}\n`,
	);
	return Promise.all(
		who.map(
			(name) =>
				new Promise<WriterResult>((fulfill) => {
					const child = spawn(process.execPath, ["--experimental-strip-types", "--import", REGISTER, scriptFile, name], { stdio: ["ignore", "pipe", "pipe"] });
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
					child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
					child.on("close", (status) => fulfill({ status: status ?? 1, stdout, stderr }));
				}),
		),
	);
}
