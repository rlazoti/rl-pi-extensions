/**
 * Symlink manager for rl-pi-extensions.
 *
 * Extensions are enabled by creating symlinks in ~/.pi/agent/extensions/
 * pointing to the extension directories. Disabled extensions have their
 * symlinks removed.
 *
 * Example:
 *   ~/.pi/agent/extensions/
 *   ├── tmux-feedback → /path/to/rl-pi-extensions/extensions/tmux-feedback
 *   ├── session-banner → /path/to/rl-pi-extensions/extensions/session-banner
 *   └── rl-extensions → /path/to/rl-pi-extensions/extensions/rl-extensions
 *
 * Trustworthiness rules:
 *   - Monorepo paths are derived from THIS file's location, never from
 *     process.cwd() (which is the user's project when Pi runs).
 *   - The extensions directory is always absolute: $HOME when usable,
 *     otherwise os.homedir(). A relative result is refused with an error
 *     instead of silently creating symlinks inside the user's project.
 *   - Enabling validates the target exists before creating a link, so we
 *     never create a broken symlink.
 *   - Enabling over a broken or stale (re-pointed) symlink repairs it
 *     instead of crashing with EEXIST.
 *   - Disabling only removes symlinks; real files/directories are never
 *     clobbered.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Test seam: tests point this at a temp directory so the real
// ~/.pi/agent/extensions/ is never touched. Pass undefined to reset.
let extensionsDirOverride: string | undefined;

export function setExtensionsDirForTesting(dir: string | undefined): void {
	extensionsDirOverride = dir;
}

/**
 * Pick the home directory the extensions directory hangs off.
 *
 * Pi's jiti runtime has historically been inconsistent about os.homedir(), so
 * $HOME wins when it is usable — but a missing or relative $HOME must never
 * degrade to a *relative* extensions directory. `process.env.HOME || ""` did
 * exactly that: enableExtension() then created .pi/agent/extensions/<name>
 * inside whatever project Pi was started in and reported success.
 */
export function resolveHomeDir(envHome: string | undefined, systemHome: string): string {
	const home = envHome && isAbsolute(envHome) ? envHome : systemHome;
	if (!isAbsolute(home)) {
		throw new Error(
			`Cannot resolve an absolute home directory (HOME=${JSON.stringify(envHome)}, ` +
				`system home=${JSON.stringify(systemHome)}); refusing to manage extensions relative to the cwd`,
		);
	}
	return home;
}

// os.homedir() returns "" when HOME is set but empty, so fall through to
// os.userInfo(), which reads the password entry and ignores $HOME.
function systemHomeDir(): string {
	try {
		return homedir() || userInfo().homedir;
	} catch {
		return "";
	}
}

export function getExtensionsDir(): string {
	return extensionsDirOverride ?? join(resolveHomeDir(process.env.HOME, systemHomeDir()), ".pi", "agent", "extensions");
}

/**
 * Resolve the monorepo root (the directory containing `extensions/`) from
 * this file's location. Works under jiti (Pi runtime, where __dirname is
 * provided) and under native ESM (node --test, where import.meta.url is
 * available and __dirname is not).
 */
export function getMonorepoRoot(): string {
	if (typeof __dirname === "string" && __dirname.length > 0) {
		return resolve(__dirname, "..");
	}
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface ExtensionDescriptor {
	name: string;
	label: string;
	description: string;
	/** Absolute path to the extension directory (contains index.ts) */
	path: string;
}

/**
 * Get the list of all available extensions from the monorepo.
 */
export function getAvailableExtensions(monorepoRoot: string): ExtensionDescriptor[] {
	return [
		{
			name: "tmux-feedback",
			label: "tmux-feedback",
			description: "Inline feedback for tmux scrollback selection",
			path: join(monorepoRoot, "extensions", "tmux-feedback"),
		},
		{
			name: "session-banner",
			label: "session-banner",
			description: "Colored banner + auto-naming for Pi sessions",
			path: join(monorepoRoot, "extensions", "session-banner"),
		},
		{
			name: "session-attention",
			label: "session-attention",
			description: "Desktop notifications when Pi needs your attention",
			path: join(monorepoRoot, "extensions", "session-attention"),
		},
		{
			name: "snippets",
			label: "snippets",
			description: "Insert predefined text snippets into the prompt",
			path: join(monorepoRoot, "extensions", "snippets"),
		},
		{
			name: "emacs-feedback",
			label: "emacs-feedback",
			description: "Source-region and Magit diff-line feedback from Emacs",
			path: join(monorepoRoot, "extensions", "emacs-feedback"),
		},
		{
			name: "memory",
			label: "memory",
			description: "Entry-keyed memory bank with a conflict gate (in development: registers nothing)",
			path: join(monorepoRoot, "extensions", "memory"),
		},
	];
}

export type ExtensionStatus = "enabled" | "broken" | "disabled";

function lstatOrNull(linkPath: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(linkPath);
	} catch {
		return undefined;
	}
}

/**
 * Check if an extension is loadable: the symlink exists AND its target
 * exists. Broken symlinks are NOT enabled (Pi cannot load them).
 */
export function isExtensionEnabled(name: string): boolean {
	return getExtensionStatus(name) === "enabled";
}

/**
 * Classify an extension's symlink state.
 *   enabled  — symlink exists and its target exists (Pi loads it)
 *   broken   — symlink exists but its target is gone (Pi skips it)
 *   disabled — no symlink (a non-symlink entry counts as disabled; it is
 *              never clobbered by enable/disable)
 */
export function getExtensionStatus(name: string): ExtensionStatus {
	const linkPath = join(getExtensionsDir(), name);
	const stat = lstatOrNull(linkPath);
	if (!stat || !stat.isSymbolicLink()) return "disabled";
	return existsSync(linkPath) ? "enabled" : "broken";
}

/**
 * Get the current enabled extensions (loadable symlinks only).
 */
export function getEnabledExtensions(): string[] {
	const dir = getExtensionsDir();
	if (!existsSync(dir)) return [];

	try {
		const entries = readdirSync(dir);
		return entries.filter((entry) => {
			// Only include loadable symlinks (not directories, regular files,
			// or broken links)
			const stat = lstatOrNull(join(dir, entry));
			return stat?.isSymbolicLink() === true && existsSync(join(dir, entry));
		});
	} catch {
		return [];
	}
}

/**
 * Enable an extension by creating (or repairing) its symlink.
 *
 *   - target missing or not a directory → throws (never creates broken links)
 *   - no entry at the link path → creates the symlink
 *   - symlink already pointing at the resolved target → no-op
 *   - broken or stale symlink → removed and re-created (repair)
 *   - real file/directory at the link path → throws (never clobbers user data)
 */
export function enableExtension(name: string, targetPath: string): void {
	const dir = getExtensionsDir();
	const linkPath = join(dir, name);
	const target = resolve(targetPath);

	if (!existsSync(target) || !statSync(target).isDirectory()) {
		throw new Error(`Extension target does not exist (expected a directory): ${target}`);
	}

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const existing = lstatOrNull(linkPath);
	if (existing) {
		if (existing.isSymbolicLink()) {
			// Resolve relative to the link's directory, not cwd.
			const current = resolve(dirname(linkPath), readlinkSync(linkPath));
			if (current === target) return; // already correct
			rmSync(linkPath, { force: true }); // broken or stale — repair below
		} else {
			throw new Error(
				`Cannot enable "${name}": ${linkPath} exists and is not a symlink. Remove it manually and retry.`,
			);
		}
	}

	symlinkSync(target, linkPath, "dir");
}

/**
 * Disable an extension by removing its symlink. Only symlinks are removed;
 * a real file/directory at the path is left untouched.
 */
export function disableExtension(name: string): void {
	const linkPath = join(getExtensionsDir(), name);
	const stat = lstatOrNull(linkPath);
	if (!stat || !stat.isSymbolicLink()) return;
	try {
		rmSync(linkPath, { force: true });
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Toggle an extension (disable if enabled or broken, enable otherwise).
 */
export function toggleExtension(name: string, targetPath: string): { enabled: boolean } {
	if (isExtensionEnabled(name) || getExtensionStatus(name) === "broken") {
		disableExtension(name);
		return { enabled: false };
	}
	enableExtension(name, targetPath);
	return { enabled: true };
}
