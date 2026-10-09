/**
 * emacs-feedback — wrapper that checks config before loading
 */

import { loadConfig, isExtensionEnabled } from "../config-manager.js";

const config = loadConfig();

let factory: any;
if (isExtensionEnabled(config, "emacs-feedback")) {
	factory = require("./implementation.js").default;
} else {
	factory = function (_pi: any) { /* disabled */ };
}

export default factory;
