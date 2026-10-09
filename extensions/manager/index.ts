/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/extensions` command → shows TUI selector
 * - Each extension checks config before registering itself
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	saveConfig,
	isExtensionEnabled,
	type ExtensionInfo,
} from "./config-manager.js";

// Registry of all available extensions
const EXTENSIONS: ExtensionInfo[] = [
	{
		name: "tmux-feedback",
		label: "tmux-feedback",
		description: "Inline feedback for tmux scrollback selection",
		enabled: true,
	},
	{
		name: "emacs-feedback",
		label: "emacs-feedback",
		description: "Emacs source-region feedback for terminal Pi sessions",
		enabled: true,
	},
	{
		name: "snippets",
		label: "snippets",
		description: "Editable multi-select snippet insertion",
		enabled: true,
	},
	{
		name: "session-attention",
		label: "session-attention",
		description: "Session attention management",
		enabled: true,
	},
	{
		name: "retitle",
		label: "retitle",
		description: "Auto-retitle sessions",
		enabled: true,
	},
];

export default function managerExtension(pi: ExtensionAPI) {
	// Register /extensions command
	pi.registerCommand("extensions", {
		description: "Manage rl-pi-extensions (enable/disable)",
		handler: async (_args, ctx) => {
			await showExtensionManager(ctx);
		},
	});
}

async function showExtensionManager(ctx: any): Promise<void> {
	const config = loadConfig();

	// Build items from registry + config state
	const items: SelectItem[] = EXTENSIONS.map((ext) => {
		const enabled = isExtensionEnabled(config, ext.name);
		return {
			value: ext.name,
			label: enabled ? `✓ ${ext.label}` : `  ${ext.label}`,
			description: ext.description,
		};
	});

	const result = await ctx.ui.custom<boolean[]>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		// Header
		container.addChild(
			new Text(theme.fg("accent", theme.bold("  rl-pi-extensions  "))),
		);
		container.addChild(
			new Text(theme.fg("dim", "Toggle extensions on/off")),
		);
		container.addChild(new Text(""));

		// Extension list
		EXTENSIONS.forEach((ext, index) => {
			const enabled = isExtensionEnabled(config, ext.name);
			const marker = enabled ? theme.fg("success", "✓") : theme.fg("dim", " ");
			const label = enabled
				? theme.fg("accent", ext.label)
				: theme.fg("muted", ext.label);
			const desc = theme.fg("dim", ext.description);

			container.addChild(
				new Text(`${marker} ${label}`),
			);
			container.addChild(
				new Text(`    ${desc}`),
			);
			container.addChild(new Text(""));
		});

		// Footer
		container.addChild(new Text(""));
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					"↑↓ navigate • space toggle • enter apply • esc cancel",
				),
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		// Track selection state
		let selectedIndex = 0;
		const toggled = new Set<string>();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Navigate
				if (data === Key.up || data === Key.left) {
					selectedIndex = Math.max(0, selectedIndex - 1);
				} else if (data === Key.down || data === Key.right) {
					selectedIndex = Math.min(EXTENSIONS.length - 1, selectedIndex + 1);
				} else if (data === Key.space) {
					// Toggle current
					const ext = EXTENSIONS[selectedIndex];
					if (toggled.has(ext.name)) {
						toggled.delete(ext.name);
					} else {
						toggled.add(ext.name);
					}
				} else if (data === Key.enter) {
					// Apply: toggle all and save
					const newConfig = { ...config };
					for (const extName of toggled) {
						const current = isExtensionEnabled(newConfig, extName);
						for (const ext of EXTENSIONS) {
							if (ext.name === extName) {
								newConfig.enabled[extName] = !current;
								break;
							}
						}
					}
					saveConfig(newConfig);
					done([...toggled]);
					return;
				} else if (data === Key.escape) {
					done([]);
					return;
				}
				tui.requestRender();
			},
		};
	});

	// After TUI closes, notify user
	if (result && result.length > 0) {
		ctx.ui.notify(
			`${result.length} extension(s) toggled. Changes apply after /reload`,
			"info",
		);
	} else {
		ctx.ui.notify("No changes made", "info");
	}
}
