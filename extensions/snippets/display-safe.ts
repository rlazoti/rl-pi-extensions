/** Makes C0, DEL, and C1 controls visible before untrusted text reaches terminal UI. */
export function displaySafe(value: string): string {
	let safe = "";
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.charCodeAt(index);
		if (codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
			const named = codePoint === 0x09 ? "\\t" : codePoint === 0x0a ? "\\n" : codePoint === 0x0d ? "\\r" : undefined;
			safe += named ?? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
		} else {
			safe += value[index];
		}
	}
	return safe;
}
