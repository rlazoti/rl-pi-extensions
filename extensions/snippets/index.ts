/**
 * snippets — insert snippets into current draft
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSnippetsExtension } from "./extension.js";

export default function snippetsExtension(pi: ExtensionAPI): void {
	registerSnippetsExtension(pi);
}
