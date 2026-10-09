/**
 * tmux-feedback — wrapper that checks config before loading
 */

import { loadConfig, isExtensionEnabled } from "../config-manager.ts";

const config = loadConfig();

let factory: any;
if (isExtensionEnabled(config, "tmux-feedback")) {
	// jiti handles this require at runtime — only resolves when enabled
	factory = require("./implementation.js").default;
} else {
	factory = function (_pi: any) { /* disabled */ };
}

export default factory;
