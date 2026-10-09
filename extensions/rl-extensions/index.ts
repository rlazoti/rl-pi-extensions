/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/rl-extensions` command → shows TUI selector
 * - Each extension checks config before registering itself
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, isExtensionEnabled, type ExtensionInfo } from "../config-manager.ts";

// Registry of all available extensions
// Note: enabled field is metadata only; actual default is disabled (opt-in)
const EXTENSIONS: ExtensionInfo[] = [
	{
		name: "tmux-feedback",
		label: "tmux-feedback",
		description: "Inline feedback for tmux scrollback selection",
		enabled: false,
	},
	{
		name: "session-banner",
		label: "session-banner",
		description: "Colored banner + auto-naming for Pi sessions",
		enabled: false,
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

	let selectedIndex = 0; // 0..EXTENSIONS.length (last index = Done)

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("  rl-pi-extensions  "))));
		container.addChild(new Text(theme.fg("dim", "Space to toggle • Enter on Done to apply")));
		container.addChild(new Text(""));

		const render = () => {
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

			// Done option
			const doneSelected = selectedIndex === EXTENSIONS.length;
			const doneLine = doneSelected
				? theme.style("▶ Done", { fg: "accent", bold: true })
				: "  Done";
			container.addChild(new Text(doneLine));
			container.addChild(new Text(""));

			// Footer
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate • space toggle • enter apply • esc cancel")),
			);
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		};

		render();

		return {
			render(width: number) {
				// Clear and re-render
				container.children.length = 0;
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold("  rl-pi-extensions  "))));
				container.addChild(new Text(theme.fg("dim", "Space to toggle • Enter on Done to apply")));
				container.addChild(new Text(""));

				EXTENSIONS.forEach((ext, index) => {
					const enabled = desiredState.get(ext.name) ?? true;
					const isSelected = index === selectedIndex;
					const marker = enabled ? theme.fg("success", "●") : theme.fg("dim", "○");
					const label = enabled
						? theme.fg("accent", ext.label)
						: theme.fg("muted", ext.label);

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

				const doneSelected = selectedIndex === EXTENSIONS.length;
				const doneLine = doneSelected
					? theme.style("▶ Done", { fg: "accent", bold: true })
					: "  Done";
				container.addChild(new Text(doneLine));
				container.addChild(new Text(""));

				container.addChild(
					new Text(
						theme.fg("dim", "↑↓ navigate • space toggle • enter apply • esc cancel"),
					),
				);
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

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
						desiredState.set(ext.name, !desiredState.get(ext.name)!);
					}
				} else if (matchesKey(data, Key.enter)) {
					// Apply if on Done, otherwise toggle
					if (selectedIndex === EXTENSIONS.length) {
						const newConfig = { ...config, enabled: { ...config.enabled } };
						for (const [extName, enabled] of desiredState) {
							newConfig.enabled[extName] = enabled;
						}
						saveConfig(newConfig);
						done();
						return;
					}
					// Toggle selected extension
					const ext = EXTENSIONS[selectedIndex];
					desiredState.set(ext.name, !desiredState.get(ext.name)!);
				} else if (matchesKey(data, Key.escape)) {
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
