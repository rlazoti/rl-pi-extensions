/**
 * session-banner — wrapper that checks config before loading
 */

import { loadConfig, isExtensionEnabled } from "../config-manager.ts";

const config = loadConfig();

let factory: any;
if (isExtensionEnabled(config, "session-banner")) {
	factory = require("./implementation.js").default;
} else {
	factory = function (_pi: any) { /* disabled */ };
}

export default factory;
