import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SCAN_LIMIT = 200;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface Revision {
	root: string;
	ref: string;
	sha: string;
}

export interface Commit {
	sha: string;
	subject: string;
	paths: string[];
}

export function isObjectId(value: unknown): value is string {
	return typeof value === "string" && OBJECT_ID.test(value);
}

export function display(value: string, limit = 120): string {
	const safe = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
		if (char === "\n") return "\\n";
		if (char === "\t") return "\\t";
		return `\\u{${char.codePointAt(0)?.toString(16)}}`;
	});
	const chars = [...safe];
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : safe;
}

export function localGit(exec: ExtensionAPI["exec"], cwd: string) {
	return async (args: string[], allowedFailure?: number) => {
		const result = await exec("git", [
			"--no-pager", "--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false", ...args,
		], { cwd, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
		if (result.truncated) throw new Error(`Git ${args[0]} produced too much output; no result was reported.`);
		if (result.killed) throw new Error(`Git ${args[0]} did not finish within the time limit.`);
		if (result.code === allowedFailure) return undefined;
		if (result.code !== 0) {
			const reason = result.stderr.trim();
			throw new Error(`Git ${args[0]} failed: ${reason || `exit ${result.code}`}`);
		}
		return result.stdout;
	};
}

type Git = ReturnType<typeof localGit>;
const line = (output: string | undefined) => output?.replace(/\n$/, "");

export async function currentRevision(git: Git): Promise<Revision> {
	const root = line(await git(["rev-parse", "--show-toplevel"]));
	const ref = line(await git(["symbolic-ref", "--quiet", "HEAD"], 1));
	if (!ref?.startsWith("refs/heads/")) throw new Error("HEAD is detached. Switch to a local branch to use /catchup.");
	const sha = line(await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 1));
	if (!root || !isObjectId(sha)) throw new Error("This branch has no commits to checkpoint yet.");
	return { root, ref, sha };
}

export function isAncestor(git: Git, baseline: string, head: string): Promise<boolean> {
	return git(["merge-base", "--is-ancestor", baseline, head], 1).then((output) => output !== undefined);
}

export async function workingPaths(git: Git): Promise<Set<string>> {
	const output = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"]);
	return new Set(output?.split("\0").filter(Boolean).map((record) => record.slice(3)));
}

export async function recentCommits(git: Git, baseline: string, head: string): Promise<Commit[]> {
	const output = await git([
		"log", "--first-parent", "--diff-merges=first-parent", "--no-renames", "--no-ext-diff", "--no-textconv",
		"--no-notes", "--no-decorate", "--no-show-signature", "--no-color", "--encoding=UTF-8",
		`--max-count=${SCAN_LIMIT + 1}`, "--name-only", "-z", "--format=%x00%H%x00%s", `${baseline}..${head}`, "--",
	]);
	if (!output) return [];

	// Each NUL-prefixed header ends the previous name list. Git adds one LF before its first path.
	const fields = output.split("\0");
	const commits: Commit[] = [];
	let i = 0;
	while (i < fields.length - 1) {
		const separator = fields[i++];
		const sha = fields[i++];
		const subject = fields[i++];
		if (separator !== "" || !isObjectId(sha) || subject === undefined) {
			throw new Error("Unexpected Git log format; no result was reported.");
		}
		const paths: string[] = [];
		while (fields[i]) {
			const path = fields[i++]!;
			paths.push(paths.length === 0 ? path.replace(/^\n/, "") : path);
		}
		commits.push({ sha, subject, paths });
	}
	if (!output.endsWith("\0")) throw new Error("Incomplete Git log; no result was reported.");
	return commits;
}
