/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/extensions` command → shows TUI selector
 * - Each extension checks config before registering itself
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text } from "@earendil-works/pi-tui";
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

	// Track desired state (overrides config while TUI is open)
	const desiredState = new Map<string, boolean>();
	for (const ext of EXTENSIONS) {
		desiredState.set(ext.name, isExtensionEnabled(config, ext.name));
	}

	let selectedIndex = 0;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
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
			const enabled = desiredState.get(ext.name) ?? true;
			const isSelected = index === selectedIndex;
			const marker = enabled ? theme.fg("success", "●") : theme.fg("dim", "○");
			const label = enabled
				? theme.fg("accent", ext.label)
				: theme.fg("muted", ext.label);

			// Highlight selected item
			let line: string;
			if (isSelected) {
				line = theme.style(`▶ ${marker} ${label}`, { fg: "accent" });
			} else {
				line = `  ${marker} ${label}`;
			}

			container.addChild(new Text(line));
			container.addChild(new Text(theme.fg("dim", `    ${ext.description}`)));
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
					desiredState.set(ext.name, !desiredState.get(ext.name)!);
				} else if (data === Key.enter) {
					// Apply: save desired state
					const newConfig = { ...config, enabled: { ...config.enabled } };
					for (const [extName, enabled] of desiredState) {
						newConfig.enabled[extName] = enabled;
					}
					saveConfig(newConfig);
					done();
					return;
				} else if (data === Key.escape) {
					done();
					return;
				}
				tui.requestRender();
			},
		};
	});

	// After TUI closes, notify user
	const changedCount = EXTENSIONS.filter(
		(ext) => isExtensionEnabled(config, ext.name) !== (desiredState.get(ext.name) ?? true),
	).length;

	if (changedCount > 0) {
		ctx.ui.notify(`${changedCount} extension(s) toggled. Changes apply after /reload`, "info");
	} else {
		ctx.ui.notify("No changes made", "info");
	}
}
