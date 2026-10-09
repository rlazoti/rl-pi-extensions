/**
 * snippets — insert snippets into the current draft
 */

import { registerSnippetsExtension } from "./extension.js";

export default function snippetsExtension(pi: any): void {
	registerSnippetsExtension(pi);
}
