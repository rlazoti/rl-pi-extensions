import assert from "node:assert/strict";
import test from "node:test";

import {
	claimInScope,
	deriveProjectId,
	globPrefix,
	inScope,
	parseScope,
	projectIdFromPaths,
	projectIdFromRemote,
	resolveIdentity,
	scopeRank,
	unrootedPathScopes,
	type ScopeContext,
} from "./scope.ts";
import type { Claim } from "./grammar.ts";

function claim(key: string, scope: string, body = `body of ${key}`): Claim {
	return { key, kind: "rule", scope, asOf: "2026-01-01", source: "a test", body, aliases: [], tags: [], links: [], origin: "agent", state: "approved" };
}

const REPO: ScopeContext = { projectId: "github.com/rlazoti/rl-pi-extensions", cwd: "/repo/rl-pi-extensions", rootPath: "/repo/rl-pi-extensions" };
const SUB: ScopeContext = { ...REPO, cwd: "/repo/rl-pi-extensions/extensions/memory" };

test("scope: parse and rank", () => {
	assert.deepEqual(parseScope("global"), { kind: "global", raw: "global" });
	assert.equal(parseScope("project:rlazoti/x")!.kind, "project");
	assert.equal(parseScope("path:src/**")!.kind, "path");
	for (const bad of ["", "project:", "path:", "user:me", "path "]) assert.equal(parseScope(bad), undefined, bad);
	assert.ok(scopeRank(parseScope("path:src/**")!) > scopeRank(parseScope("project:a/b")!));
	assert.ok(scopeRank(parseScope("project:a/b")!) > scopeRank(parseScope("global")!));
});

test("scope: a project id comes from the remote, the repo root, or the cwd (R8)", () => {
	assert.equal(projectIdFromRemote("git@github.com:rlazoti/rl-pi-extensions.git"), "github.com/rlazoti/rl-pi-extensions");
	assert.equal(projectIdFromRemote("https://GitHub.com/rlazoti/rl-pi-extensions.git"), "github.com/rlazoti/rl-pi-extensions");
	assert.equal(projectIdFromRemote("https://gitlab.com/team/deep/project"), "gitlab.com/team/deep/project");
	assert.equal(projectIdFromRemote("ssh://git@git.example.com:2222/org/tool.git"), "git.example.com/org/tool");
	assert.equal(projectIdFromRemote("not a url"), undefined);
	assert.equal(projectIdFromRemote(""), undefined);

	assert.equal(deriveProjectId({ remote: "git@github.com:rlazoti/x.git", gitRoot: "/somewhere/x", cwd: "/somewhere/x" }), "github.com/rlazoti/x");
	assert.equal(deriveProjectId({ gitRoot: "/somewhere/x", cwd: "/somewhere/x/sub" }), "x", "no remote: the repo root names the project");
	assert.equal(deriveProjectId({ cwd: "/tmp/scratch-dir" }), "scratch-dir", "not a repo: the working directory names it");
	assert.equal(projectIdFromPaths(undefined, "/"), "/");
});

test("scope: the static prefix of a glob is the tree it describes", () => {
	assert.equal(globPrefix("extensions/memory/**"), "extensions/memory");
	assert.equal(globPrefix("src/ui/*.tsx"), "src/ui");
	assert.equal(globPrefix("./src/ui/*.tsx"), "src/ui");
	assert.equal(globPrefix("**/*.test.ts"), "", "no prefix: this glob describes no tree");
	assert.equal(globPrefix("/Users/me/repo/docs/**"), "/Users/me/repo/docs");
});

test("scope: a path scope covers a session at, above or inside the tree it names (R9)", () => {
	const glob = "path:extensions/memory/**";
	assert.ok(inScope(parseScope(glob)!, REPO), "session at the repo root works on that tree");
	assert.ok(inScope(parseScope(glob)!, SUB), "session inside the tree");
	const inExtensions: ScopeContext = { ...REPO, cwd: "/repo/rl-pi-extensions/extensions" };
	assert.ok(inScope(parseScope(glob)!, inExtensions), "session above the tree");
	const elsewhere: ScopeContext = { ...REPO, cwd: "/repo/rl-pi-extensions/src" };
	assert.ok(!inScope(parseScope(glob)!, elsewhere), "a session in a sibling tree is not covered");
});

test("scope: an absolute path scope is decided against the session, not by luck", () => {
	const here = "path:/repo/rl-pi-extensions/extensions/**";
	const there = "path:/repo/other-project/src/**";
	assert.ok(inScope(parseScope(here)!, REPO));
	assert.ok(inScope(parseScope(here)!, SUB));
	assert.ok(!inScope(parseScope(there)!, REPO), "a scope pointing at another repository never injects here");
});

test("scope: a glob with no tree never injects, and doctor reports it", () => {
	const loose = claim("style.tests", "path:**/*.test.ts");
	assert.ok(!claimInScope(loose, REPO));
	assert.deepEqual(unrootedPathScopes([loose, claim("a.b", "global")]).map((c) => c.key), ["style.tests"]);
});

test("scope: project scopes match only their own project (R9)", () => {
	const mine = claim("build.gate", "project:github.com/rlazoti/rl-pi-extensions");
	const theirs = claim("build.gate", "project:github.com/someone/else");
	assert.ok(claimInScope(mine, REPO));
	assert.ok(!claimInScope(theirs, REPO));
});

test("scope: one key, one answer — a narrower scope shadows a broader one (R10)", () => {
	const scope = resolveIdentity(
		"tests.runner",
		[claim("tests.runner", "global", "npm test"), claim("tests.runner", "project:github.com/rlazoti/rl-pi-extensions", "npm test here"), claim("tests.runner", "path:extensions/memory/**", "npm test one file here")],
		SUB,
	);
	assert.equal(scope.winner?.scope, "path:extensions/memory/**");
	assert.deepEqual(scope.shadowed.map((c) => c.scope).sort(), ["global", "project:github.com/rlazoti/rl-pi-extensions"]);
	assert.deepEqual(scope.contested, []);
	assert.deepEqual(scope.outOfScope, []);
});

test("scope: out-of-scope claims never win and are reported separately (R9)", () => {
	const scope = resolveIdentity("a.b", [claim("a.b", "global", "wins"), claim("a.b", "project:github.com/x/y", "never here")], REPO);
	assert.equal(scope.winner?.body, "wins");
	assert.deepEqual(scope.outOfScope.map((c) => c.scope), ["project:github.com/x/y"]);
});

test("scope: two claims at one level for one key are contested and inject nothing (R12)", () => {
	const scope = resolveIdentity("a.b", [claim("a.b", "global", "first"), claim("a.b", "global", "second")], REPO);
	assert.equal(scope.winner, undefined);
	assert.deepEqual(scope.contested.map((c) => c.body), ["first", "second"]);
});

test("scope: two matching path globs for one key are contested too", () => {
	const scope = resolveIdentity("a.b", [claim("a.b", "path:extensions/**"), claim("a.b", "path:extensions/memory/**")], SUB);
	assert.equal(scope.winner, undefined);
	assert.equal(scope.contested.length, 2);
});
