/** The version is the bytes actually served, never a later stat of the pathname. */
import { createHash } from "node:crypto";

export function fingerprint(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export class ServedVersions {
	private seen = new Map<string, { hash: string; partial: boolean }>();
	clear(): void { this.seen.clear(); }
	forget(rel: string): void { this.seen.delete(rel); }
	note(rel: string, content: string, partial = false): void {
		const hash = fingerprint(content);
		const previous = this.seen.get(rel);
		// A smaller view of unchanged bytes cannot erase a complete copy still in
		// the transcript. New bytes (or a transcript reset) must earn that trust again.
		const complete = previous?.hash === hash && !previous.partial;
		this.seen.set(rel, { hash, partial: partial && !complete });
	}

	complete(rel: string, content: string): boolean {
		const previous = this.seen.get(rel);
		return !!previous && !previous.partial && previous.hash === fingerprint(content);
	}

	refusal(rel: string, current: string | null, allowUnread = false): string | null {
		const previous = this.seen.get(rel);
		if (!previous) {
			return current !== null && !allowUnread
				? `${rel} exists but has not been read in this session (read it first; allowUnread explicitly permits a blind replacement)`
				: null;
		}
		if (current === null) return "the file has since been deleted";
		if (previous.hash !== fingerprint(current)) return `${rel} changed on disk since this session last saw it`;
		return previous.partial ? `only part of ${rel} has been shown to this session, and replacing the file would drop the rest` : null;
	}
}
