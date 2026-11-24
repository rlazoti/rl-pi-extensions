import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	currentRevision, display, isAncestor, isObjectId, localGit, recentCommits, SCAN_LIMIT, workingPaths,
	type Commit, type Revision,
} from "./git.js";

const ENTRY_TYPE = "rl-catchup.checkpoint";
const ROW_LIMIT = 8;
const PATH_LIMIT = 3;

interface Checkpoint extends Revision {
	sessionId: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function readCheckpoint(branch: SessionEntry[], sessionId: string): Checkpoint | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = asRecord(entry.data);
		if (data?.sessionId !== sessionId) continue;
		const { root, ref, sha } = data;
		if (typeof root === "string" && typeof ref === "string" && isObjectId(sha)) {
			return { sessionId, root, ref, sha };
		}
	}
	return undefined;
}

function addToolPath(paths: Set<string>, cwd: string, root: string, args: unknown): void {
	const value = asRecord(args)?.path;
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return;
	let path = value.replace(/^@/, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	if (path.startsWith("file://")) {
		try {
			path = fileURLToPath(path);
		} catch {
			return;
		}
	}
	if (path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"))) path = resolve(homedir(), path.slice(2));
	const fromRoot = relative(root, resolve(cwd, path));
	if (fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)) {
		paths.add(fromRoot.split(sep).join("/"));
	}
}

function isEdit(name: unknown): boolean {
	return name === "edit" || name === "write";
}

function toolPaths(branch: SessionEntry[], cwd: string, root: string): Set<string> {
	const paths = new Set<string>();
	const pending = new Map<string, { name: string; args: unknown }>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			pending.clear();
			for (const part of message.content) {
				if (part.type === "toolCall" && isEdit(part.name)) {
					pending.set(part.id, { name: part.name, args: part.arguments });
				}
			}
		} else if (message.role === "toolResult") {
			const call = pending.get(message.toolCallId);
			if (call && call.name === message.toolName && !message.isError) {
				addToolPath(paths, cwd, root, call.args);
			}
			pending.delete(message.toolCallId);

			// A parent tool that failed may still have completed edits before it stopped.
			for (const nested of message.nestedCalls?.calls ?? []) {
				if (nested.status === "ok" && isEdit(nested.name)) {
					addToolPath(paths, cwd, root, nested.arguments);
				}
			}
		}
	}
	return paths;
}

function branchName(ref: string): string {
	return display(ref.replace(/^refs\/heads\//, ""));
}

function report(revision: Revision, baseline: Checkpoint, commits: Commit[], evidence: Set<string>): string {
	const branch = branchName(revision.ref);
	const range = `${branch} since ${baseline.sha.slice(0, 7)}`;
	if (commits.length === 0) return `/catchup: No new commits on ${range}.`;

	const partial = commits.length > SCAN_LIMIT;
	const rows = commits.slice(0, SCAN_LIMIT).map((commit) => ({
		...commit,
		matches: [...new Set(commit.paths.filter((path) => evidence.has(path)))],
	}));
	const overlaps = rows.filter((row) => row.matches.length > 0);
	const other = rows.filter((row) => row.matches.length === 0);
	const count = partial ? `At least ${commits.length} new commits (checked newest ${SCAN_LIMIT})` :
		`${commits.length} new commit${commits.length === 1 ? "" : "s"}`;
	const lines = [
		`/catchup: ${count} on ${range}.`,
		evidence.size
			? `${overlaps.length} overlapping commit${overlaps.length === 1 ? "" : "s"} in this scan (checked ${evidence.size} edited or currently changed path${evidence.size === 1 ? "" : "s"}).`
			: "No path evidence from recorded edits or current working changes; showing recent commits.",
	];
	for (const row of [...overlaps, ...other].slice(0, ROW_LIMIT)) {
		const paths = row.matches.slice(0, PATH_LIMIT).map((path) => display(path, 80));
		if (row.matches.length > PATH_LIMIT) paths.push(`+${row.matches.length - PATH_LIMIT} more`);
		lines.push(`  ${row.sha.slice(0, 7)}  ${display(row.subject) || "(no subject)"}${paths.length ? ` — ${paths.join(", ")}` : ""}`);
	}
	if (rows.length > ROW_LIMIT) lines.push(`  … ${rows.length - ROW_LIMIT} more scanned commits not shown.`);
	return lines.join("\n");
}

export default function catchup(pi: ExtensionAPI): void {
	let running = false;
	pi.registerCommand("catchup", {
		description: "Show local commits since this session's Git checkpoint, overlaps first",
		handler: async (args, ctx) => {
			const usage = "/catchup compares with the saved checkpoint. /catchup mark saves or replaces it.";
			const action = args.trim();
			if (action !== "" && action !== "mark") {
				ctx.ui.notify(usage, "info");
				return;
			}
			if (running || !ctx.isIdle()) {
				ctx.ui.notify("/catchup: Wait for the session and any previous check to finish.", "warning");
				return;
			}

			running = true;
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const branch = ctx.sessionManager.getBranch();
				const cwd = await realpath(ctx.cwd);
				const git = localGit(pi.exec, cwd);
				const revision = await currentRevision(git);
				const baseline = readCheckpoint(branch, sessionId);

				if (!baseline || action === "mark") {
					pi.appendEntry<Checkpoint>(ENTRY_TYPE, { sessionId, ...revision });
					const persistence = !ctx.sessionManager.getSessionFile() ? " In-memory session only." :
						branch.some((entry) => entry.type === "message" &&
							(entry.message.role === "user" || entry.message.role === "assistant")) ? "" :
							" Pi will save it to disk after the first conversation message.";
					ctx.ui.notify(`/catchup: Checkpoint set on ${branchName(revision.ref)} at ${revision.sha.slice(0, 7)}.${persistence}`, "info");
					return;
				}

				if (baseline.root !== revision.root || baseline.ref !== revision.ref) {
					throw new Error(`Checkpoint belongs to a different checkout or branch (${branchName(baseline.ref)}). Switch back or run /catchup mark to replace it.`);
				}
				if (baseline.sha === revision.sha) {
					ctx.ui.notify(report(revision, baseline, [], new Set()), "info");
					return;
				}

				const repoGit = localGit(pi.exec, revision.root);
				const ancestor = await isAncestor(repoGit, baseline.sha, revision.sha);
				if (!ancestor) {
					throw new Error("The checkpoint is not an ancestor of HEAD (history may have been reset, rewritten, or shallow). Check the branch or run /catchup mark to replace it.");
				}
				const [commits, working] = await Promise.all([
					recentCommits(repoGit, baseline.sha, revision.sha),
					workingPaths(repoGit),
				]);
				const edited = toolPaths(branch, cwd, revision.root);
				const evidence = new Set([...working, ...edited]);
				ctx.ui.notify(report(revision, baseline, commits, evidence), "info");
			} catch (error) {
				ctx.ui.notify(`/catchup: ${display(error instanceof Error ? error.message : String(error), 260)}`, "warning");
			} finally {
				running = false;
			}
		},
	});
}
