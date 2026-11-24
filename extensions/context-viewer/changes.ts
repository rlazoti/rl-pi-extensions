import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface RecordedResponse {
	id: string;
	timestamp: string;
	outcome?: "error" | "aborted";
}

interface NamedChange {
	name: string;
	kind: "Added" | "Removed" | "Changed";
}

export type RequestChanges =
	| { unavailable: string }
	| {
		previous: RecordedResponse;
		latest: RecordedResponse;
		compactionsBetween: number;
		compactionsAfter: number;
		loadout?: { promptTextChanged: boolean; sections: NamedChange[]; tools: NamedChange[] };
	};

export async function readRequestChanges(branch: SessionEntry[]): Promise<RequestChanges> {
	const boundaries: Array<{ response: RecordedResponse; index: number }> = [];
	for (let index = branch.length - 1; index >= 0 && boundaries.length < 2; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			const { stopReason } = entry.message;
			const outcome = stopReason === "error" || stopReason === "aborted" ? stopReason : undefined;
			boundaries.push({ response: { id: entry.id, timestamp: entry.timestamp, outcome }, index });
		}
	}
	const [latest, previous] = boundaries;
	if (!previous || !latest) return { unavailable: "This branch needs two recorded assistant responses to compare." };

	// The live projection may have compacted away either boundary. Replay each
	// historical leaf instead, including only the compaction checkpoint it saw.
	const [{ buildSessionContext }, { getCurrentSystemMessage, declarationsEqual }] = await Promise.all([
		import("@earendil-works/pi-coding-agent"),
		import("@earendil-works/pi-ai"),
	]);
	const before = getCurrentSystemMessage(buildSessionContext(branch, previous.response.id).messages);
	const after = getCurrentSystemMessage(buildSessionContext(branch, latest.response.id).messages);

	return {
		previous: previous.response,
		latest: latest.response,
		compactionsBetween: countCompactions(branch.slice(previous.index + 1, latest.index)),
		compactionsAfter: countCompactions(branch.slice(latest.index + 1)),
		loadout: before && after ? {
			promptTextChanged: before.content !== after.content,
			sections: diffNamed(new Map(Object.entries(before.sections ?? {})), new Map(Object.entries(after.sections ?? {})), (a, b) => a === b),
			tools: diffNamed(new Map(before.toolsAdded?.map((tool) => [tool.name, tool])), new Map(after.toolsAdded?.map((tool) => [tool.name, tool])), declarationsEqual),
		} : undefined,
	};
}

function countCompactions(entries: SessionEntry[]): number {
	return entries.filter((entry) => entry.type === "compaction").length;
}

function diffNamed<T>(before: Map<string, T>, after: Map<string, T>, equal: (before: T, after: T) => boolean): NamedChange[] {
	const changes: NamedChange[] = [];
	for (const [name, value] of before) {
		if (!after.has(name)) changes.push({ name, kind: "Removed" });
		else if (!equal(value, after.get(name)!)) changes.push({ name, kind: "Changed" });
	}
	for (const name of after.keys()) {
		if (!before.has(name)) changes.push({ name, kind: "Added" });
	}
	return changes;
}
