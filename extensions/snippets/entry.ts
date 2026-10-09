import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSnippetsExtension } from "./extension.ts";

export { registerSnippetsExtension, SNIPPETS_SHORTCUT } from "./extension.ts";

export default function snippetsExtension(pi: ExtensionAPI): void {
	registerSnippetsExtension(pi);
}
