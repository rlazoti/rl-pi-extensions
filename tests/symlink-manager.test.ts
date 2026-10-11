import assert from "node:assert/strict";
import test from "node:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	enableExtension,
	disableExtension,
	getAvailableExtensions,
	getEnabledExtensions,
	getExtensionStatus,
	getExtensionsDir,
	getMonorepoRoot,
	isExtensionEnabled,
	setExtensionsDirForTesting,
	toggleExtension,
} from "../extensions/symlink-manager.ts";

// Run the real module against a temp extensions dir so the user's
// ~/.pi/agent/extensions/ is never touched.
function withExtensionsDir(fn: (ctx: { extensionsDir: string; srcDir: string }) => void): void {
	const root = mkdirSync(join(tmpdir(), `rl-pi-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
		recursive: true,
	});
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

test("getAvailableExtensions returns the 5 managed extensions under the given root", () => {
	const exts = getAvailableExtensions("/fake/path");
	assert.equal(exts.length, 5);
	assert.deepEqual(
		exts.map((e) => e.name),
		["tmux-feedback", "session-banner", "session-attention", "snippets", "emacs-feedback"],
	);
	assert.equal(exts[0].description, "Inline feedback for tmux scrollback selection");
	assert.equal(exts[1].description, "Colored banner + auto-naming for Pi sessions");
	assert.equal(exts[2].description, "Desktop notifications when Pi needs your attention");
	assert.equal(exts[3].description, "Insert predefined text snippets into the prompt");
	assert.equal(exts[4].description, "Source-region and Magit diff-line feedback from Emacs");
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
