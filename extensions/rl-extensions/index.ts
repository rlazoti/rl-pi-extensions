/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/rl-extensions` command → shows TUI selector
 * - Extensions are enabled/disabled via symlinks in ~/.pi/agent/extensions/
 * - Changes take effect after /reload
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	getAvailableExtensions,
	getEnabledExtensions,
	isExtensionEnabled,
	toggleExtension,
	type ExtensionDescriptor,
} from "../symlink-manager.js";

// Get monorepo root from this file's location
const MONOREPO_ROOT = process.cwd();

// Registry of all available extensions
const EXTENSIONS: ExtensionDescriptor[] = getAvailableExtensions(MONOREPO_ROOT);

export default function managerExtension(pi: ExtensionAPI) {
	// Register /rl-extensions command
	pi.registerCommand("rl-extensions", {
		description: "Manage rl-pi-extensions (enable/disable via symlinks)",
		handler: async (_args, ctx) => {
			await showExtensionManager(ctx);
		},
	});
}

async function showExtensionManager(ctx: ExtensionCommandContext): Promise<void> {
	let selectedIndex = 0;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();

		const render = () => {
			container.children.length = 0;
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("  rl-pi-extensions  ")), 1, 1));
			container.addChild(new Text(theme.fg("dim", "Space to toggle • Enter on Done to apply"), 1, 1));

			EXTENSIONS.forEach((ext, index) => {
				const enabled = isExtensionEnabled(ext.name);
				const isSelected = index === selectedIndex;
				const marker = enabled ? theme.fg("success", "●") : theme.fg("dim", "○");
				const label = enabled
					? theme.fg("accent", ext.label)
					: theme.fg("muted", ext.label);

				// Show name and description on same line: ● name — description
				let line: string;
				if (isSelected) {
					line = theme.style(`▶ ${marker} ${label} — ${ext.description}`, { fg: "accent" });
				} else {
					line = `  ${marker} ${label} — ${ext.description}`;
				}

				container.addChild(new Text(line, 1, 0));
			});

			// Done option
			const doneSelected = selectedIndex === EXTENSIONS.length;
			const doneLine = doneSelected
				? theme.style("▶ Done", { fg: "accent", bold: true })
				: "  Done";
			container.addChild(new Text(doneLine, 1, 1));

			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate • space toggle • enter apply • esc cancel"), 1, 0),
			);
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		};

		render();

		return {
			render(width: number) {
				render();
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// Navigate
				if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
				} else if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
					selectedIndex = Math.min(EXTENSIONS.length, selectedIndex + 1);
				} else if (matchesKey(data, Key.space)) {
					// Toggle current extension (not Done)
					if (selectedIndex < EXTENSIONS.length) {
						const ext = EXTENSIONS[selectedIndex];
						toggleExtension(ext.name, ext.path);
					}
				} else if (matchesKey(data, Key.enter)) {
					// Apply if on Done, otherwise toggle
					if (selectedIndex === EXTENSIONS.length) {
						done();
						return;
					}
					// Toggle selected extension
					const ext = EXTENSIONS[selectedIndex];
					toggleExtension(ext.name, ext.path);
				} else if (matchesKey(data, Key.escape)) {
					done();
					return;
				}
				tui.requestRender();
			},
		};
	});

	// After TUI closes, notify user
	const enabled = getEnabledExtensions();
	const changedCount = EXTENSIONS.filter((ext) => isExtensionEnabled(ext.name)).length;

	if (changedCount > 0) {
		ctx.ui.notify(
			`${changedCount} extension(s) enabled. Changes apply after /reload`,
			"info",
		);
	} else {
		ctx.ui.notify("All extensions disabled", "info");
	}
}
