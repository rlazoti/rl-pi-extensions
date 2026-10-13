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
			const enabledCount = result.enabledCount;
			if (enabledCount > 0) {
				ctx.ui.notify(`${enabledCount} extension(s) enabled. Changes apply after /reload`, "info");
			} else {
				ctx.ui.notify("All extensions disabled", "info");
			}
			// Surface per-extension failures (e.g. a non-symlink entry occupying
			// the link path) instead of silently skipping them.
			for (const error of result.errors) {
				ctx.ui.notify(`rl-extensions: ${error}`, "error");
			}
		},
	});
}
