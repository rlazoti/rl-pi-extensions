/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/rl-extensions` command → shows framed TUI picker
 * - Extensions are enabled/disabled via symlinks in ~/.pi/agent/extensions/
 * - Changes take effect after /reload
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openExtensionPicker, type ExtensionPickerResult } from "./picker.js";

export default function managerExtension(pi: ExtensionAPI) {
	pi.registerCommand("rl-extensions", {
		description: "Manage rl-pi-extensions (enable/disable via symlinks)",
		handler: async (_args, ctx) => {
			const result = await openExtensionPicker(ctx.ui);
			if (result.kind === "cancel") return;
			const { enabledCount, changedCount, errors } = result;
			// enabledCount alone is not what the user just did: disabling one of five
			// printed "4 extension(s) enabled", and pressing Enter without touching
			// anything printed "5 extension(s) enabled".
			if (changedCount === 0) {
				ctx.ui.notify(`No changes — ${enabledCount} enabled`, "info");
			} else if (enabledCount === 0) {
				ctx.ui.notify("All extensions disabled. Changes apply after /reload", "info");
			} else {
				ctx.ui.notify(
					`${changedCount} change(s) applied — ${enabledCount} enabled. Changes apply after /reload`,
					"info",
				);
			}
			// Surface per-extension failures (e.g. a non-symlink entry occupying
			// the link path) instead of silently skipping them.
			for (const error of result.errors) {
				ctx.ui.notify(`rl-extensions: ${error}`, "error");
			}
		},
	});
}
