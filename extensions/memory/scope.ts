/**
 * Scope: which claims are about *this* session, and which one answers a question
 * when several do (R8-R10).
 *
 * A scope is one of three things, and the order is not decoration: a rule for a
 * directory beats a rule for a repository, which beats a rule for everything.
 * One question gets one answer (R10); two claims at the same level for one key
 * are a contradiction the extension is not allowed to pick a side in (R12).
 */

import { minimatch } from "minimatch";

import type { Claim } from "./grammar.js";

/**
 * minimatch options, pinned on purpose:
 *  - `dot`: `extensions/**` must match a dotfile like `.pi/config`; a memory
 *    scope is about the tree, not about a hidden-file exclusion.
 *  - `nonegate` / `nocomment`: a glob is data typed by an agent, and `!foo` or
 *    `#foo` in a path scope means the path, not an operator.
 */
export const GLOB_OPTIONS = { dot: true, nonegate: true, nocomment: true } as const;

export type ParsedScope =
	| { kind: "global"; raw: "global" }
	| { kind: "project"; raw: string; id: string }
	| { kind: "path"; raw: string; glob: string };

export interface ScopeContext {
	/** Project id for this session (R8): git remote, else repo root, else cwd. */
	projectId: string;
	cwd: string;
	/** Repo root when there is one, else cwd. Path scopes are read against this. */
	rootPath: string;
}

/** Higher number is narrower, and a narrower scope shadows a broader one (R10). */
export function scopeRank(scope: ParsedScope): number {
	if (scope.kind === "path") return 3;
	if (scope.kind === "project") return 2;
	return 1;
}

export function parseScope(raw: string): ParsedScope | undefined {
	if (raw === "global") return { kind: "global", raw };
	if (raw.startsWith("project:")) {
		const id = raw.slice("project:".length).trim();
		return id === "" ? undefined : { kind: "project", raw, id };
	}
	if (raw.startsWith("path:")) {
		const glob = raw.slice("path:".length).trim();
		return glob === "" ? undefined : { kind: "path", raw, glob };
	}
	return undefined;
}

/**
 * The longest leading path segment of a glob with no magic in it:
 * `extensions/memory/**` → `extensions/memory`, `**​/*.test.ts` → ``.
 *
 * A session has one working directory, so a path scope can only be decided by
 * the relationship between that directory and the glob's tree. A glob with no
 * static prefix describes no tree — `doctor` calls those out, because an
 * unrooted pattern silently never injects.
 */
export function globPrefix(glob: string): string {
	const segments = glob.split("/");
	const prefix: string[] = [];
	for (const segment of segments) {
		if (/[*?[\]{}!]/.test(segment)) break;
		prefix.push(segment);
	}
	return prefix.join("/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

function isWithin(parent: string, child: string): boolean {
	if (parent === child) return true;
	return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** The cwd, relative to the scope root, in posix form. "." when they are equal. */
export function relativeTarget(ctx: ScopeContext): string {
	const root = toPosix(ctx.rootPath);
	const cwd = toPosix(ctx.cwd);
	if (cwd === root) return ".";
	if (isWithin(root, cwd)) return cwd.slice(root.length + 1);
	return cwd; // outside the repo: keep the absolute path so a rooted glob can still match
}

export function inScope(scope: ParsedScope, ctx: ScopeContext): boolean {
	if (scope.kind === "global") return true;
	if (scope.kind === "project") return scope.id === ctx.projectId;

	const glob = scope.glob;
	const target = relativeTarget(ctx);
	if (minimatch(target, glob, GLOB_OPTIONS)) return true;

	const prefix = globPrefix(glob);
	if (prefix === "") return false;
	const root = toPosix(ctx.rootPath);
	if (prefix.startsWith("/")) {
		// An absolute glob names a tree directly: in scope when that tree is under
		// this session's root, or when this session is inside it.
		return isWithin(root, prefix) || isWithin(prefix, toPosix(ctx.cwd));
	}
	// A relative glob is rooted at the scope root. In scope when the tree it names
	// is at or below the session's directory, or when the session's directory is
	// inside it. Both sides are relative to that root.
	if (target === ".") return true;
	if (isWithin(target, prefix)) return true;
	return isWithin(prefix, target);
}

export function claimInScope(claim: Claim, ctx: ScopeContext): boolean {
	const scope = parseScope(claim.scope);
	return scope !== undefined && inScope(scope, ctx);
}

export interface IdentityResolution {
	key: string;
	/** The one claim this context answers with, or nothing when contested (R12). */
	winner?: Claim;
	/** In-scope claims a narrower scope shadowed (R10). */
	shadowed: Claim[];
	/** Rivals at the same scope level: nothing is injected for this key. */
	contested: Claim[];
	/** Claims that are not about this session at all (R9). */
	outOfScope: Claim[];
}

/**
 * Resolve one key to one claim for one context. Scope decides; nothing here
 * looks at dates, because "which claim is current" is decided by the store
 * (one approved claim per identity), not by the reader.
 */
export function resolveIdentity(key: string, claims: Claim[], ctx: ScopeContext): IdentityResolution {
	const outOfScope: Claim[] = [];
	const inScopeClaims: { claim: Claim; rank: number }[] = [];
	for (const claim of claims) {
		const scope = parseScope(claim.scope);
		if (!scope || !inScope(scope, ctx)) {
			outOfScope.push(claim);
			continue;
		}
		inScopeClaims.push({ claim, rank: scopeRank(scope) });
	}
	const best = Math.max(...inScopeClaims.map((entry) => entry.rank), 0);
	const rivals = inScopeClaims.filter((entry) => entry.rank === best).map((entry) => entry.claim);
	const shadowed = inScopeClaims.filter((entry) => entry.rank !== best).map((entry) => entry.claim);
	if (rivals.length === 0) return { key, shadowed, contested: [], outOfScope };
	if (rivals.length > 1) return { key, shadowed, contested: rivals, outOfScope };
	return { key, winner: rivals[0], shadowed, contested: [], outOfScope };
}

/**
 * Project id (R8). A remote is preferred because it is the same identifier on
 * any clone: `github.com/owner/repo`. Without a remote the repository's own
 * directory name is the best available name, and without a repository the
 * working directory is.
 */
export function projectIdFromRemote(remote: string): string | undefined {
	const url = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
	if (url === "") return undefined;
	const sshLike = /^[A-Za-z0-9_.-]+@([A-Za-z0-9.-]+):(.+)$/.exec(url);
	if (sshLike) return `${sshLike[1]!.toLowerCase()}/${sshLike[2]!}`;
	const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.+)$/.exec(url);
	if (withScheme) {
		const rest = withScheme[1]!;
		const slash = rest.indexOf("/");
		if (slash <= 0) return undefined;
		const host = rest.slice(0, slash).replace(/^([^@]*@)/, "").replace(/:\d+$/, "").toLowerCase();
		const path = rest.slice(slash + 1);
		return path === "" ? undefined : `${host}/${path}`;
	}
	return undefined;
}

export function projectIdFromPaths(gitRoot: string | undefined, cwd: string): string {
	const source = gitRoot ?? cwd;
	const trimmed = source.replace(/\/+$/, "");
	if (trimmed === "") return "/"; // the filesystem root is a working directory too
	const base = trimmed.split("/").pop() ?? trimmed;
	return base === "" ? trimmed : base;
}

export function deriveProjectId(parts: { remote?: string; gitRoot?: string; cwd: string }): string {
	const fromRemote = parts.remote ? projectIdFromRemote(parts.remote) : undefined;
	if (fromRemote) return fromRemote;
	return projectIdFromPaths(parts.gitRoot, parts.cwd);
}

/** Scope strings worth warning about: a path scope that can never select a session. */
export function unrootedPathScopes(claims: Claim[]): Claim[] {
	return claims.filter((claim) => {
		const scope = parseScope(claim.scope);
		return scope !== undefined && scope.kind === "path" && globPrefix(scope.glob) === "";
	});
}
