/**
 * tmux-feedback — inline feedback for tmux scrollback selection
 */

import { isExtensionEnabled } from "../symlink-manager.js";

// Check if extension is enabled (symlink exists)
const enabled = isExtensionEnabled("tmux-feedback");

let factory: any;
if (enabled) {
	// jiti handles this require at runtime
	factory = require("./implementation.js").default;
} else {
	factory = function (_pi: any) { /* disabled */ };
}

export default factory;
