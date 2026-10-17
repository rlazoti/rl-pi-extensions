/**
 * The session-start review notice (R20, D1).
 *
 * A new session says, once, what is waiting on Rodrigo — and nothing at all when
 * nothing is. It never blocks: the notice is a line, not a dialog, because a
 * memory system that interrupts a session is a memory system that gets turned
 * off.
 */

import type { QueueCounts } from "./queue.js";

export interface NoticeOptions {
	pendingFlagDays: number;
	/** Damage in the bank (unreadable stores, half-written files) is said at the same time. */
	bankDamage?: string[];
}

/** One line, naming only what is actually waiting. `undefined` when nothing is. */
export function reviewNotice(counts: QueueCounts, opts: NoticeOptions): string | undefined {
	const parts: string[] = [];
	if (counts.agentProposals > 0) parts.push(`${counts.agentProposals} proposal${counts.agentProposals === 1 ? "" : "s"} from the agent`);
	if (counts.migrationBacklog > 0) parts.push(`${counts.migrationBacklog} migrated claim${counts.migrationBacklog === 1 ? "" : "s"} (migration backlog)`);
	if (counts.contested.length > 0) parts.push(`${counts.contested.length} contested identit${counts.contested.length === 1 ? "y" : "ies"}`);
	if (counts.flagged.length > 0) parts.push(`${counts.flagged.length} waiting longer than ${opts.pendingFlagDays} days`);
	if (parts.length === 0 && (opts.bankDamage ?? []).length === 0) return undefined;

	const lines: string[] = [];
	if (parts.length > 0) {
		lines.push(`memory: ${counts.total} claim${counts.total === 1 ? "" : "s"} await review — ${parts.join("; ")}. Run /memory review.`);
		if (counts.coarseDates > 0) lines.push(`memory: ${counts.coarseDates} of them have no proposal date, so their age is counted from the claim's own date`);
		for (const contest of counts.contested.slice(0, 3)) lines.push(`memory: contested — ${contest.key} @ ${contest.scope} (${contest.files.join(", ")}): nothing is injected for it`);
		if (counts.contested.length > 3) lines.push(`memory: …and ${counts.contested.length - 3} more contested identities`);
	}
	for (const problem of opts.bankDamage ?? []) lines.push(`memory: ${problem}`);
	return lines.join("\n");
}

/**
 * Where the notice goes. In the TUI it is a notification. Outside it — print
 * mode, RPC — it is written once to the log: the same information, without a
 * second copy of anything.
 */
export interface NoticeSink {
	state: { shown: number; logged: number };
	deliver: (notice: string | undefined) => "shown" | "logged" | "silent";
}

export function createNoticeSink(handlers: {
	isTui: boolean;
	notify: (text: string) => void;
	log: (text: string) => void;
}): NoticeSink {
	const state = { shown: 0, logged: 0 };
	return {
		state,
		deliver(notice: string | undefined): "shown" | "logged" | "silent" {
			if (notice === undefined) return "silent";
			if (handlers.isTui) {
				handlers.notify(notice);
				state.shown++;
				return "shown";
			}
			// Outside a TUI there is no one watching a notification, so the first
			// notice is written to the log and later ones are only counted.
			if (state.logged === 0) handlers.log(notice);
			state.logged++;
			return "logged";
		},
	};
}
