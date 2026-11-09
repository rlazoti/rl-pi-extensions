/**
 * Extension Manager — TUI for enabling/disabling rl-pi-extensions
 *
 * Provides:
 * - `/rl-extensions` command → shows framed TUI picker
 * - Extensions are enabled/disabled via symlinks in ~/.pi/agent/extensions/
 * - Changes take effect after /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openExtensionPicker } from "./picker.js";

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
				ctx.ui.notify("All extensions disabled.", "info");
			} else {
				ctx.ui.notify(`${changedCount} change(s) applied — ${enabledCount} enabled.`, "info");
			}
			// Report failures before asking, including when only some changes succeeded.
			for (const error of errors) {
				ctx.ui.notify(`rl-extensions: ${error}`, "error");
			}
			if (changedCount === 0) return;
			if (await ctx.ui.confirm("Reload Pi now?", "Changes take effect after reload. Other sessions must be reloaded separately.")) {
				await ctx.reload();
				return;
			}
			ctx.ui.notify("Changes apply after /reload", "info");
		},
	});
}
