/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/rl-extensions` command → shows TUI selector
 * - Each extension checks config before registering itself
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	saveConfig,
	isExtensionEnabled,
	type ExtensionInfo,
} from "../config-manager.js";

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

	// Build items for SelectList
	const buildItems = (): SelectItem[] => {
		const items: SelectItem[] = EXTENSIONS.map((ext) => {
			const enabled = desiredState.get(ext.name) ?? true;
			return {
				value: ext.name,
				label: enabled ? `✓ ${ext.label}` : `○ ${ext.label}`,
				description: ext.description,
			};
		});
		// Add "Done" option at the end
		items.push({
			value: "__done__",
			label: "Done",
			description: "Apply changes and close",
		});
		return items;
	};

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("  rl-pi-extensions  "))));
		container.addChild(new Text(theme.fg("dim", "Enter to toggle • Enter on Done to apply")));
		container.addChild(new Text(""));

		const items = buildItems();
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		selectList.onSelect = (item) => {
			if (item.value === "__done__") {
				// Apply changes
				const newConfig = { ...config, enabled: { ...config.enabled } };
				for (const [extName, enabled] of desiredState) {
					newConfig.enabled[extName] = enabled;
				}
				saveConfig(newConfig);
				done();
				return;
			}
			// Toggle the selected extension
			const extName = item.value;
			const current = desiredState.get(extName) ?? true;
			desiredState.set(extName, !current);
			// Update the list
			selectList.setItems(buildItems());
			tui.requestRender();
		};

		selectList.onCancel = () => {
			done();
		};

		container.addChild(selectList);
		container.addChild(new Text(""));
		container.addChild(
			new Text(theme.fg("dim", "↑↓ navigate • enter toggle/select • esc cancel")),
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
				selectList.handleInput(data);
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
