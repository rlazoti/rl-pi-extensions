/**
 * session-banner — colored banner + auto-naming for Pi sessions
 */

import { isExtensionEnabled } from "../symlink-manager.js";

// Check if extension is enabled (symlink exists)
const enabled = isExtensionEnabled("session-banner");

let factory: any;
if (enabled) {
	// jiti handles this require at runtime
	factory = require("./implementation.js").default;
} else {
	factory = function (_pi: any) { /* disabled */ };
}

export default factory;
