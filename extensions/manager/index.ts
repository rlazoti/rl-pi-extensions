/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/rl-extensions` command → shows TUI selector
 * - Each extension checks config before registering itself
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, isExtensionEnabled, type ExtensionInfo } from "../config-manager.js";

// Registry of all available extensions
const EXTENSIONS: ExtensionInfo[] = [
	{
		name: "tmux-feedback",
		label: "tmux-feedback",
		description: "Inline feedback for tmux scrollback selection",
		enabled: true,
	},
];

export default function managerExtension(pi: ExtensionAPI) {
	// Register /rl-extensions command
	pi.registerCommand("rl-extensions", {
		description: "Manage rl-pi-extensions (enable/disable)",
		handler: async (_args, ctx) => {
			await showExtensionManager(ctx);
		},
	});
}

async function showExtensionManager(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();

	// Build items for selection list
	const buildItems = (): string[] => {
		return EXTENSIONS.map((ext) => {
			const enabled = isExtensionEnabled(config, ext.name);
			return enabled ? `✓ ${ext.label}` : `○ ${ext.label}`;
		}).concat(["(done)"]);
	};

	let changedCount = 0;

	// Loop: show list, let user toggle, repeat until "(done)"
	while (true) {
		const items = buildItems();
		const selected = await ctx.ui.select("rl-pi-extensions", items);
		if (selected === undefined) {
			// User cancelled (esc)
			break;
		}

		if (selected === "(done)") {
			break;
		}

		// Find which extension was selected
		const extIndex = items.indexOf(selected);
		if (extIndex === -1 || extIndex >= EXTENSIONS.length) continue;

		const ext = EXTENSIONS[extIndex];
		const wasEnabled = isExtensionEnabled(config, ext.name);
		const newEnabled = !wasEnabled;

		// Update config
		const newConfig = {
			...config,
			enabled: { ...config.enabled, [ext.name]: newEnabled },
		};
		saveConfig(newConfig);
		changedCount++;
	}

	// Notify user
	if (changedCount > 0) {
		ctx.ui.notify(`${changedCount} extension(s) toggled. Changes apply after /reload`, "info");
	} else {
		ctx.ui.notify("No changes made", "info");
	}
}
