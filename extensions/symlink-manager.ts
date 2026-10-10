/**
 * Symlink manager for rl-pi-extensions.
 *
 * Extensions are enabled by creating symlinks in ~/.pi/agent/extensions/
 * pointing to the extension directories. Disabled extensions have their
 * symlinks removed.
 *
 * Example:
 *   ~/.pi/agent/extensions/
 *   ├── tmux-feedback → /path/to/rl-pi-extensions/extensions/tmux-feedback/
 *   ├── session-banner → /path/to/rl-pi-extensions/extensions/session-banner/
 *   └── rl-extensions → /path/to/rl-pi-extensions/extensions/rl-extensions/
 */

import { existsSync, lstatSync, readlinkSync, symlinkSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const AGENT_DIR = join(process.env.HOME || "", ".pi", "agent");
const EXTENSIONS_DIR = join(AGENT_DIR, "extensions");

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
	];
}

/**
 * Check if an extension is enabled (symlink exists, even if broken).
 * Uses lstatSync to detect the entry without following the symlink,
 * so broken symlinks are still detected as "enabled".
 */
export function isExtensionEnabled(name: string): boolean {
	const linkPath = join(EXTENSIONS_DIR, name);
	try {
		lstatSync(linkPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the current enabled extensions.
 */
export function getEnabledExtensions(): string[] {
	if (!existsSync(EXTENSIONS_DIR)) return [];

	try {
		const entries = readdirSync(EXTENSIONS_DIR);
		return entries.filter((entry) => {
			const linkPath = join(EXTENSIONS_DIR, entry);
			// Only include symlinks (not directories or regular files)
			try {
				return readlinkSync(linkPath) !== undefined;
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}

/**
 * Enable an extension by creating a symlink.
 * If the entry already exists (valid symlink, broken symlink, file, or dir),
 * this is a no-op — we never crash on EEXIST.
 */
export function enableExtension(name: string, targetPath: string): void {
	const linkPath = join(EXTENSIONS_DIR, name);

	// Create extensions directory if it doesn't exist
	if (!existsSync(EXTENSIONS_DIR)) {
		mkdirSync(EXTENSIONS_DIR, { recursive: true });
	}

	// If anything already exists at this path, noop
	if (existsSync(linkPath)) return;

	// Create absolute symlink
	symlinkSync(resolve(targetPath), linkPath, "dir");
}

/**
 * Disable an extension by removing its symlink.
 */
export function disableExtension(name: string): void {
	const linkPath = join(EXTENSIONS_DIR, name);
	try {
		rmSync(linkPath, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Toggle an extension (enable if disabled, disable if enabled).
 */
export function toggleExtension(name: string, targetPath: string): { enabled: boolean } {
	if (isExtensionEnabled(name)) {
		disableExtension(name);
		return { enabled: false };
	} else {
		enableExtension(name, targetPath);
		return { enabled: true };
	}
}
