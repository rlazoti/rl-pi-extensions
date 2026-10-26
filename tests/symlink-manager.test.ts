import assert from "node:assert/strict";
import test from "node:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
	enableExtension,
	disableExtension,
	getAvailableExtensions,
	getEnabledExtensions,
	getExtensionStatus,
	getExtensionsDir,
	getMonorepoRoot,
	isExtensionEnabled,
	resolveHomeDir,
	setExtensionsDirForTesting,
	toggleExtension,
} from "../extensions/symlink-manager.ts";

// Run the real module against a temp extensions dir so the user's
// ~/.pi/agent/extensions/ is never touched.
test("catalog lists every loadable extension directory in the monorepo", () => {
	const root = getMonorepoRoot();
	const onDisk = readdirSync(join(root, "extensions"))
		.filter((entry) => entry !== "rl-extensions") // the manager is loaded by package.json, never toggled
		.filter((entry) => {
			const dir = join(root, "extensions", entry);
			return lstatSync(dir).isDirectory() && existsSync(join(dir, "index.ts"));
		})
		.sort();
	const catalog = getAvailableExtensions(root)
		.map((extension) => extension.name)
		.sort();

	// The picker only ever offers catalog entries, so an unlisted directory is
	// silently un-manageable rather than an error.
	assert.deepEqual(catalog, onDisk, "every extensions/<dir> with an index.ts must be in the catalog");

	for (const extension of getAvailableExtensions(root)) {
		assert.ok(existsSync(extension.path), `catalog entry ${extension.name} points at a missing directory: ${extension.path}`);
		assert.ok(extension.description.length > 0, `catalog entry ${extension.name} has no description`);
	}
});

test("resolveHomeDir never yields a relative base for the extensions directory", () => {
	assert.equal(resolveHomeDir("/home/u", "/other"), "/home/u", "an absolute $HOME wins");
	assert.equal(resolveHomeDir(undefined, "/home/u"), "/home/u", "unset $HOME falls back to os.homedir()");
	assert.equal(resolveHomeDir("", "/home/u"), "/home/u", "empty $HOME falls back to os.homedir()");
	assert.equal(resolveHomeDir(".pi", "/home/u"), "/home/u", "relative $HOME is not usable");
	assert.throws(
		() => resolveHomeDir("", ""),
		/Cannot resolve an absolute home directory/,
		"a relative extensions directory must be refused, not created under the cwd",
	);
});

test("getExtensionsDir stays absolute when HOME is empty or unset", () => {
	const savedHome = process.env.HOME;
	setExtensionsDirForTesting(undefined);
	try {
		process.env.HOME = "";
		const withEmptyHome = getExtensionsDir();
		delete process.env.HOME;
		const withNoHome = getExtensionsDir();

		for (const [label, dir] of [
			["empty", withEmptyHome],
			["unset", withNoHome],
		] as const) {
			assert.ok(isAbsolute(dir), `HOME ${label} must not produce a relative extensions dir: ${dir}`);
			assert.ok(
				!dir.startsWith(process.cwd() + "/"),
				`HOME ${label} must not resolve inside the project cwd: ${dir}`,
			);
			assert.ok(dir.endsWith(join(".pi", "agent", "extensions")), `unexpected extensions dir: ${dir}`);
		}
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		setExtensionsDirForTesting(undefined);
	}
});

function withExtensionsDir(fn: (ctx: { extensionsDir: string; srcDir: string }) => void): void {
	const root = join(tmpdir(), `rl-pi-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	const extensionsDir = join(root, "agent", "extensions");
	const srcDir = join(root, "src");
	mkdirSync(extensionsDir, { recursive: true });
	mkdirSync(srcDir, { recursive: true });

	setExtensionsDirForTesting(extensionsDir);
	try {
		fn({ extensionsDir, srcDir });
	} finally {
		setExtensionsDirForTesting(undefined);
		rmSync(root, { recursive: true, force: true });
	}
}

function makeExt(srcDir: string, name: string): string {
	const dir = join(srcDir, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// --- Registry & path derivation ---

test("getAvailableExtensions returns the 7 managed extensions under the given root", () => {
	const exts = getAvailableExtensions("/fake/path");
	assert.equal(exts.length, 7);
	assert.deepEqual(
		exts.map((e) => e.name),
		["tmux-feedback", "session-banner", "session-attention", "snippets", "emacs-feedback", "memory", "co-authored-by-ai"],
	);
	assert.equal(exts[0].description, "Inline feedback for tmux scrollback selection");
	assert.equal(exts[1].description, "Colored banner + auto-naming for Pi sessions");
	assert.equal(exts[2].description, "Desktop notifications when Pi needs your attention");
	assert.equal(exts[3].description, "Insert predefined text snippets into the prompt");
	assert.equal(exts[4].description, "Source-region and Magit diff-line feedback from Emacs");
	// The description is what the picker shows before someone enables a live
	// component: it says what the thing does, not where its migration is up to.
	assert.match(exts[5].description, /one authority per claim/);
	// Says what the patch does to the command, because that is the part a reader
	// has to trust before enabling something that rewrites their git invocations.
	assert.match(exts[6].description, /Co-authored-by: AI/);
	for (const ext of exts) {
		assert.equal(resolve(ext.path), resolve("/fake/path", "extensions", ext.name));
	}
});

test("getMonorepoRoot resolves to the directory containing extensions/symlink-manager.ts", () => {
	const root = getMonorepoRoot();
	assert.ok(
		existsSync(join(root, "extensions", "symlink-manager.ts")),
		`expected ${root} to contain extensions/symlink-manager.ts`,
	);
	assert.ok(existsSync(join(root, "package.json")));
});

test("getExtensionsDir defaults to ~/.pi/agent/extensions", () => {
	setExtensionsDirForTesting(undefined);
	assert.ok(getExtensionsDir().endsWith(join(".pi", "agent", "extensions")));
});

test("setExtensionsDirForTesting overrides the extensions dir", () => {
	withExtensionsDir(({ extensionsDir }) => {
		assert.equal(getExtensionsDir(), extensionsDir);
	});
});

// --- Status classification ---

test("getExtensionStatus returns disabled when no entry exists", () => {
	withExtensionsDir(() => {
		assert.equal(getExtensionStatus("test-ext"), "disabled");
		assert.equal(isExtensionEnabled("test-ext"), false);
	});
});

test("getExtensionStatus returns broken for a broken symlink and enabled for a valid one", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		const target = makeExt(srcDir, "test-ext");
		const linkPath = join(extensionsDir, "test-ext");

		// Broken: target deleted after the link was created
		symlinkSync(target, linkPath, "dir");
		rmSync(target, { recursive: true, force: true });
		assert.equal(getExtensionStatus("test-ext"), "broken");
		assert.equal(isExtensionEnabled("test-ext"), false, "broken symlinks are not loadable");

		// Valid again
		mkdirSync(target, { recursive: true });
		assert.equal(getExtensionStatus("test-ext"), "enabled");
		assert.equal(isExtensionEnabled("test-ext"), true);
	});
});

test("a non-symlink entry counts as disabled (never clobbered)", () => {
	withExtensionsDir(({ extensionsDir }) => {
		mkdirSync(join(extensionsDir, "real-dir"), { recursive: true });
		assert.equal(getExtensionStatus("real-dir"), "disabled");
	});
});

// --- enableExtension ---

test("enableExtension creates a valid directory symlink", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		const target = makeExt(srcDir, "test-ext");
		enableExtension("test-ext", target);

		const linkPath = join(extensionsDir, "test-ext");
		assert.ok(lstatSync(linkPath).isSymbolicLink());
		assert.equal(resolve(readlinkSync(linkPath)), resolve(target));
		assert.equal(getExtensionStatus("test-ext"), "enabled");
	});
});

test("enableExtension noops when the symlink already points at the target", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		const target = makeExt(srcDir, "test-ext");
		enableExtension("test-ext", target);
		// Second call must not throw
		assert.doesNotThrow(() => enableExtension("test-ext", target));
		assert.equal(resolve(readlinkSync(join(extensionsDir, "test-ext"))), resolve(target));
	});
});

test("enableExtension repairs a broken symlink (EEXIST regression)", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		const linkPath = join(extensionsDir, "test-ext");
		// Broken symlink: points at a target that no longer exists
		symlinkSync(join(srcDir, "gone"), linkPath, "dir");
		assert.equal(getExtensionStatus("test-ext"), "broken");

		const target = makeExt(srcDir, "test-ext");
		// Must not throw EEXIST; must re-point at the live target
		assert.doesNotThrow(() => enableExtension("test-ext", target));
		assert.equal(resolve(readlinkSync(linkPath)), resolve(target));
		assert.equal(getExtensionStatus("test-ext"), "enabled");
	});
});

test("enableExtension re-points a stale symlink from another checkout", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		const oldTarget = makeExt(srcDir, "old-checkout-ext");
		const linkPath = join(extensionsDir, "test-ext");
		symlinkSync(oldTarget, linkPath, "dir");
		assert.equal(getExtensionStatus("test-ext"), "enabled");

		const newTarget = makeExt(srcDir, "test-ext");
		enableExtension("test-ext", newTarget);
		assert.equal(resolve(readlinkSync(linkPath)), resolve(newTarget));
	});
});

test("enableExtension throws when the target does not exist", () => {
	withExtensionsDir(({ srcDir }) => {
		assert.throws(
			() => enableExtension("test-ext", join(srcDir, "missing")),
			/does not exist/,
		);
		assert.equal(getExtensionStatus("test-ext"), "disabled");
	});
});

test("enableExtension throws when a real directory occupies the link path", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		mkdirSync(join(extensionsDir, "test-ext"), { recursive: true });
		const target = makeExt(srcDir, "real");

		assert.throws(() => enableExtension("test-ext", target), /not a symlink/);
		// The real directory must survive untouched
		assert.ok(lstatSync(join(extensionsDir, "test-ext")).isDirectory());
		assert.equal(getExtensionStatus("test-ext"), "disabled");
	});
});

// --- disableExtension ---

test("disableExtension removes the symlink", () => {
	withExtensionsDir(({ srcDir }) => {
		enableExtension("test-ext", makeExt(srcDir, "test-ext"));
		disableExtension("test-ext");
		assert.equal(getExtensionStatus("test-ext"), "disabled");
	});
});

test("disableExtension is a no-op when nothing exists", () => {
	withExtensionsDir(() => {
		assert.doesNotThrow(() => disableExtension("test-ext"));
	});
});

test("disableExtension leaves a real directory untouched", () => {
	withExtensionsDir(({ extensionsDir }) => {
		mkdirSync(join(extensionsDir, "test-ext"), { recursive: true });
		disableExtension("test-ext");
		assert.ok(lstatSync(join(extensionsDir, "test-ext")).isDirectory());
	});
});

// --- toggleExtension ---

test("toggleExtension enables when disabled", () => {
	withExtensionsDir(({ srcDir }) => {
		const result = toggleExtension("test-ext", makeExt(srcDir, "test-ext"));
		assert.equal(result.enabled, true);
		assert.equal(getExtensionStatus("test-ext"), "enabled");
	});
});

test("toggleExtension disables when enabled", () => {
	withExtensionsDir(({ srcDir }) => {
		const target = makeExt(srcDir, "test-ext");
		enableExtension("test-ext", target);
		const result = toggleExtension("test-ext", target);
		assert.equal(result.enabled, false);
		assert.equal(getExtensionStatus("test-ext"), "disabled");
	});
});

test("toggleExtension disables a broken symlink", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		const linkPath = join(extensionsDir, "test-ext");
		symlinkSync(join(srcDir, "gone"), linkPath, "dir");
		const result = toggleExtension("test-ext", makeExt(srcDir, "test-ext"));
		assert.equal(result.enabled, false);
		assert.equal(getExtensionStatus("test-ext"), "disabled");
	});
});

// --- getEnabledExtensions ---

test("getEnabledExtensions returns loadable symlink names only", () => {
	withExtensionsDir(({ extensionsDir, srcDir }) => {
		// Valid symlink
		enableExtension("test-ext", makeExt(srcDir, "test-ext"));
		// Broken symlink
		symlinkSync(join(srcDir, "gone"), join(extensionsDir, "broken-ext"), "dir");
		// Real directory (another package's extension)
		mkdirSync(join(extensionsDir, "other-ext"), { recursive: true });

		assert.deepEqual(getEnabledExtensions(), ["test-ext"]);
	});
});
