/**
 * The use-case layer between the modules and Pi (the spec calls it
 * `implementation.ts`; it is kept separate so every decision here is testable
 * without a Pi process).
 *
 * One `Bank` per session: it owns the config, the cached claim snapshot, the
 * project identity, and the day the session thinks it is. Every operation returns
 * a plain result object plus text for a human, so the Pi adapter only has to
 * decide where the text goes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { applyConfig, loadConfig, describeConfig, describeConfigSource, describeSettings, type ConfigResult } from "./config.js";
import { dailyStatus, readDaily, rolloverDaily, appendDailyItem, type DailyLog } from "./daily.js";
import { gateDaily, gatePropose } from "./gate.js";
import { buildInjection, formatPreview, type InjectionResult } from "./inject.js";
import { archiveText, backupBank, ensureBankDirs, FileLocked, inspectBank, isLockFile, readClaims, bankPaths as pathsFor, writeAtomic, StoreUnreadable, type BankHealth, type BankPaths, type BankSnapshot, type ExecFn } from "./store.js";
import { listPending, propose, approve, reject as rejectClaim, defer as deferClaim, editPending, queueCounts, describePending, type PendingEntry, type QueueCounts } from "./queue.js";
import { reviewNotice, type NoticeOptions } from "./notice.js";
import { bm25, createRanker, type RankedText } from "./rank.js";
import { deriveProjectId, type ScopeContext } from "./scope.js";
import { dayOf, describeAge, shiftDay, systemClock, type Clock } from "./time.js";
import { identityOf, parseStore, type Claim } from "./grammar.js";
import {
	cutoverSources,
	applyMigration,
	draftQueue,
	migrateDailyItems,
	formatMigrationProgress,
	markDrafted,
	migrationProgress,
	nextDraft,
	planMigration,
	recordBackup,
	savePlan,
	readState,
	type MigrationState,
} from "./migrate.js";
import { appendContextMetric, appendErrorMetric, appendTurn, computeBaseline, errorFile, formatTrialReport, readErrorMetrics, readFlags, recordFlag, recordOverride, trialReport, writeBaseline, type TrialReport } from "./trial.js";

export interface BankOptions {
	paths?: BankPaths;
	clock?: Clock;
	exec?: ExecFn;
	/** A runner for `git`, injected so no test ever shells out. */
	git?: (cwd: string) => Promise<{ root?: string; remote?: string }>;
}

export interface Outcome<T = unknown> {
	ok: boolean;
	/** What a human reads. */
	text: string;
	data?: T;
}

export interface SearchHit {
	/** `claim` | `pending` | `history` | `daily` | `archive`. */
	origin: string;
	label: string;
	text: string;
	score: number;
}

export class Bank {
	readonly paths: BankPaths;
	private readonly clock: Clock;
	private readonly git: (cwd: string) => Promise<{ root?: string; remote?: string }>;
	private configCache: ConfigResult | undefined;
	private configSignature = "";
	private snapshotCache: BankSnapshot | undefined;
	private snapshotSignature = "";
	private contextCache = new Map<string, ScopeContext>();
	private dayCache: string | undefined;
	private rolledOver = false;

	constructor(opts: BankOptions = {}) {
		this.paths = opts.paths ?? pathsFor();
		this.clock = opts.clock ?? systemClock;
		this.git = opts.git ?? defaultGitProbe;
	}

	// ── Basics ───────────────────────────────────────────────────────────────

	get today(): string {
		return dayOf(this.clock());
	}

	/**
	 * The config file is hand-editable like the claim stores, so the cache is keyed
	 * on it the same way (name, mtime, size): an edit in an editor reaches the next
	 * turn of a running session instead of waiting for a restart (R48).
	 */
	config(): ConfigResult {
		const signature = this.configSignatureOf();
		if (this.configCache === undefined || signature !== this.configSignature) {
			this.configCache = loadConfig(this.paths);
			this.configSignature = signature;
		}
		return this.configCache;
	}

	private configSignatureOf(): string {
		try {
			const stat = statSync(this.paths.config);
			return `${Math.round(stat.mtimeMs)}:${stat.size}`;
		} catch {
			return "absent";
		}
	}

	/** Report a config object the caller just edited, without pretending to read the file. */
	setConfig(raw: unknown): string[] {
		const applied = applyConfig(raw, this.paths.config);
		this.configCache = applied;
		this.configSignature = this.configSignatureOf();
		return applied.warnings;
	}

	/** Every setting with its default, its range, and where the value in use came from (R48). */
	settings(): Outcome<ConfigResult> {
		const result = this.config();
		return {
			ok: true,
			text: describeSettings(result, { file: this.paths.config, present: existsSync(this.paths.config) }),
			data: result,
		};
	}

	/**
	 * The claim stores are hand-editable, and more than one Pi session can hold a
	 * bank open. So the cache is keyed on the stores' identity (name, mtime, size):
	 * an edit made in an editor, or an approval made in another session, is seen by
	 * the next turn instead of the next restart.
	 */
	snapshot(): BankSnapshot {
		const signature = this.storeSignature();
		if (this.snapshotCache === undefined || signature !== this.snapshotSignature) {
			this.snapshotCache = readClaims(this.paths);
			this.snapshotSignature = signature;
		}
		return this.snapshotCache;
	}

	private storeSignature(): string {
		const parts: string[] = [];
		for (const dir of [this.paths.rules, this.paths.facts]) {
			for (const name of safeReaddir(dir).sort()) {
				if (isLockFile(name)) continue;
				try {
					const stat = statSync(join(dir, name));
					parts.push(`${name}:${Math.round(stat.mtimeMs)}:${stat.size}`);
				} catch {
					parts.push(`${name}:unreadable`);
				}
			}
		}
		return parts.join(",");
	}

	private invalidate(): void {
		this.snapshotCache = undefined;
		this.snapshotSignature = "";
	}

	async context(cwd: string): Promise<ScopeContext> {
		const cached = this.contextCache.get(cwd);
		if (cached) return cached;
		const probe = await this.git(cwd);
		const context: ScopeContext = {
			projectId: deriveProjectId({ remote: probe.remote, gitRoot: probe.root, cwd }),
			cwd,
			rootPath: probe.root ?? cwd,
		};
		this.contextCache.set(cwd, context);
		return context;
	}

	/** The daily log is rolled over once per session, the first time it is needed. */
	rollover(): { day: string; carried: number; archivedTo?: string; reason?: string; futureDated: boolean } {
		if (!this.rolledOver) {
			ensureBankDirs(this.paths);
			const result = rolloverDaily(this.paths, { today: this.today });
			// A log another session is still writing is not a rollover that happened:
			// stay un-rolled so the next turn tries again.
			if (result.skipped !== true) this.rolledOver = true;
			this.dayCache = this.today;
			return { day: this.today, ...result };
		}
		return { day: this.dayCache ?? this.today, carried: 0, futureDated: false, reason: "already rolled this session" };
	}

	daily(): DailyLog {
		return readDaily(this.paths, this.today);
	}

	/**
	 * What is wrong with the bank right now, one line per problem (R36). Empty means
	 * healthy. This exists because a `StoreUnreadable` used to be a string inside a
	 * caught `Outcome`: a bank whose store no writer could reproduce produced no output
	 * at all, in any mode.
	 */
	describeDamage(): string[] {
		const health = inspectBank(this.snapshot(), this.paths);
		const lines: string[] = [];
		if (health.malformed.length > 0) lines.push(`${health.malformed.length} malformed entries: ${health.malformed.map((error) => `${error.file}:${error.line} — ${error.message}`).join("; ")}`);
		if (health.unwritable.length > 0) lines.push(`${health.unwritable.length} line(s) no writer can reproduce: ${health.unwritable.map((problem) => `${problem.file}:${problem.line} — ${problem.text}`).join("; ")}`);
		if (health.contested.length > 0) lines.push(`${health.contested.length} contested identities: ${health.contested.map((entry) => `${entry.key} @ ${entry.scope}`).join(", ")}`);
		if (health.unreadable.length > 0) lines.push(`${health.unreadable.length} unreadable stores: ${health.unreadable.map((entry) => entry.file).join(", ")}`);
		if (health.tempFiles.length > 0) lines.push(`${health.tempFiles.length} half-written files: ${health.tempFiles.join(", ")}`);
		if (health.outsideLinks.length > 0) lines.push(`${health.outsideLinks.length} links leave the bank: ${health.outsideLinks.map((entry) => entry.file).join(", ")}`);
		return lines;
	}

	/**
	 * One line in `metrics/errors.jsonl` for a failure that otherwise disappears (R36).
	 * Never throws: the failure being reported has already happened, and a broken
	 * logger must not add a second one.
	 */
	recordError(where: string, message: string, sessionId?: string): boolean {
		try {
			ensureBankDirs(this.paths);
			return appendErrorMetric(this.paths, { where, message, ...(sessionId === undefined ? {} : { session: sessionId }) }, this.clock);
		} catch {
			return false;
		}
	}

	/**
	 * The measurement behind the trial (F6). It used to be reachable only as
	 * "trial: never", which said neither how old the data was nor where it came from.
	 */
	measurement(): string[] {
		const report = trialReport(this.paths, { today: this.today });
		if (report.turns === 0) {
			return [`measure: no injected turn recorded in the last ${report.days} days — the first one writes ${join(this.paths.metrics, "turns.jsonl")}`];
		}
		const context = report.context === undefined
			? "no model call sampled yet"
			: `${report.context.samples} model calls sampled, median ${report.context.medianKept} memory tokens carried and ${report.context.medianDropped} dropped`;
		const lines = [`measure: ${report.turns} injected turn${report.turns === 1 ? "" : "s"}, median ${report.medianTokens} tokens${report.newestAt === undefined ? "" : `, newest ${report.newestAt}`}; ${context}`];
		const baseline = report.baseline === undefined
			? "no baseline — /memory trial baseline computes one from session files (R47)"
			: `baseline ${report.baseline.medianTokens} tokens from ${report.baseline.samples} blocks marked "${report.baseline.marker}", ${describeAge(report.baseline.generatedAt.slice(0, 10), this.today)} old (${report.baseline.from} to ${report.baseline.to})`;
		const sinceDay = shiftDay(this.today, -(report.days - 1));
		const errors = readErrorMetrics(this.paths, { sinceDay }).length;
		const flags = report.flags.total;
		lines.push(`window: ${baseline}; ${flags} flagged stale or rival, ${errors} error${errors === 1 ? "" : "s"} recorded in the last ${report.days} days — /memory trial report [days] [--last n]; files: ${this.paths.metrics}`);
		return lines;
	}

	// ── Injection ────────────────────────────────────────────────────────────

	async injection(query: string, cwd: string, sessionId: string, opts: { record?: boolean } = {}): Promise<{ result: InjectionResult; warnings: string[]; context: ScopeContext }> {
		const context = await this.context(cwd);
		const { config, warnings } = this.config();
		const snapshot = this.snapshot();
		const pending = listPending(snapshot, { today: this.today, pendingFlagDays: config.pendingFlagDays });
		const ages = new Map(pending.map((entry) => [identityOf(entry.claim), entry.ageDays]));
		const rankerName = config.ranker;
		const { ranker, known } = createRanker(rankerName);
		const localWarnings = [...warnings];
		if (!known) localWarnings.push(`ranker "${rankerName}" is not implemented — bm25 was used instead`);
		const result = buildInjection({
			claims: snapshot.claims,
			daily: this.daily(),
			query,
			ctx: context,
			config,
			today: this.today,
			ranker,
			ageOf: (claim) => ages.get(identityOf(claim)) ?? 0,
		});
		// Only a turn that really happened is a measurement. `/memory preview` runs
		// the same code to show what a turn would cost, and a preview counted as a
		// turn moved the trial's own median (F2-b).
		if (result.text !== "" && opts.record !== false) {
			appendTurn(
				this.paths,
				{
					tokens: result.tokens,
					dropped: { claims: result.dropped.rule + result.dropped.fact, dailyItems: result.dropped.dailyItems },
					claims: snapshot.claims.filter((claim) => claim.state === "approved").length,
					session: sessionId,
				},
				this.clock,
			);
		}
		return { result, warnings: localWarnings, context };
	}

	/** What a turn would receive, without recording that it happened (R31). */
	preview(query: string, cwd: string): Promise<Outcome<InjectionResult>> {
		return this.injection(query, cwd, "preview", { record: false }).then(({ result, warnings }) => ({
			ok: true,
			text: [formatPreview(result), ...warnings.map((warning) => `warning: ${warning}`)].join("\n"),
			data: result,
		}));
	}

	notice(cwd: string, opts: Pick<NoticeOptions, "bankDamage"> = {}): Promise<Outcome<string>> {
		const { config, warnings } = this.config();
		const snapshot = this.snapshot();
		const counts = queueCounts(snapshot, { today: this.today, pendingFlagDays: config.pendingFlagDays });
		const damage = [...(opts.bankDamage ?? []), ...warnings];
		const text = reviewNotice(counts, { pendingFlagDays: config.pendingFlagDays, bankDamage: damage });
		return Promise.resolve({ ok: true, text: text ?? "", data: text ?? undefined });
	}

	queueCounts(): QueueCounts {
		const { config } = this.config();
		return queueCounts(this.snapshot(), { today: this.today, pendingFlagDays: config.pendingFlagDays });
	}

	/** What one model call was about to carry (D24). Never breaks the call (R30). */
	recordContext(sample: { blocks: number; keptBlocks: number; droppedBlocks: number; keptTokens: number; droppedTokens: number; carried: boolean }, sessionId: string): void {
		try {
			appendContextMetric(this.paths, { ...sample, session: sessionId }, this.clock);
		} catch {
			// A metric that cannot be written is not a reason to send the wrong
			// conversation, or to refuse to send one at all.
		}
	}

	// ── Writes ───────────────────────────────────────────────────────────────

	log(input: { section: unknown; text: unknown }): Outcome<{ stamp: string }> {
		const gate = gateDaily(input);
		if (!gate.ok) return { ok: false, text: `refused: ${gate.problems.join("; ")}` };
		ensureBankDirs(this.paths);
		this.rollover();
		try {
			const appended = appendDailyItem(this.paths, { section: gate.section, text: gate.text, clock: this.clock });
			return { ok: true, text: `logged ${appended.item.section} at ${appended.item.stamp} — ${appended.item.text}`, data: { stamp: appended.item.stamp } };
		} catch (error) {
			return { ok: false, text: `refused: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	proposeClaim(input: {
		key: string;
		kind: string;
		scope: string;
		asOf: string;
		source: string;
		body: string;
		aliases?: string[];
		tags?: string[];
		links?: string[];
		origin?: "agent" | "migration";
		overrideStatusCheck?: boolean;
		overrideReason?: string;
		/** The session that asked, recorded on an override so a count has a source. */
		session?: string;
	}): Outcome<{ file: string; against?: Claim }> {
		const claim: Claim = {
			key: input.key,
			kind: input.kind as Claim["kind"],
			scope: input.scope,
			asOf: input.asOf,
			source: input.source,
			body: input.body,
			aliases: input.aliases ?? [],
			tags: input.tags ?? [],
			links: input.links ?? [],
			origin: input.origin ?? "agent",
			state: "pending",
			proposedAt: this.today,
		};
		const gate = gatePropose({ claim, overrideStatusCheck: input.overrideStatusCheck, overrideReason: input.overrideReason });
		if (!gate.ok) {
			return { ok: false, text: `refused: ${gate.problems.join("\n")}${gate.redirect ? `\nredirect: ${gate.redirect}` : ""}` };
		}
		ensureBankDirs(this.paths);
		let stored;
		try {
			stored = propose(this.paths, gate.claim, this.today);
		} catch (error) {
			return this.refusal(error);
		}
		this.invalidate();
		// D14 only becomes a number if each override is recorded once, at the
		// proposal it belongs to. A counter in the extension process counted every
		// later turn instead, and `/memory trial` never showed it (F2-c).
		if (gate.claim.statusOverride) {
			recordOverride(this.paths, { key: gate.claim.key, scope: gate.claim.scope, reason: gate.claim.statusOverride, session: input.session ?? "unknown" }, this.clock);
		}
		const waiting = stored.against
			? ` It waits against the approved claim ("${stored.against.body}") and will not be injected until you approve it.`
			: gate.claim.origin === "migration"
				? " It is part of the migration backlog: it never injects until you approve it (/memory review --wave migration)."
				: " Nothing is approved yet for this key, so it injects as [unapproved] until you review it.";
		return {
			ok: true,
			text: `proposed ${gate.claim.key} @ ${gate.claim.scope} (pending, ${gate.claim.origin}).${waiting}${gate.claim.statusOverride ? `\nstatus check overridden: ${gate.claim.statusOverride}` : ""}${stored.replacedDraft ? `\nthe previous draft for this identity is in ${stored.replacedDraft.file}` : ""}`,
			data: { file: stored.file, against: stored.against },
		};
	}

	archive(name: string, text: string): Outcome<{ file: string }> {
		if (text.trim() === "") return { ok: false, text: "refused: there is nothing to archive" };
		ensureBankDirs(this.paths);
		const stored = archiveText(this.paths, name, text);
		return { ok: true, text: `archived to ${stored.file} (read-only; never injected, searchable by memory_search)`, data: stored };
	}

	// ── Review ───────────────────────────────────────────────────────────────

	/**
	 * The queue as text. Past a dozen claims the dialog walk stops being a
	 * review, so the full listing also goes to a file in the bank: hand-editable,
	 * searchable, and the thing to read beside `/memory approve --wave …`.
	 */
	reviewList(opts: { wave?: "agent" | "migration" } = {}): { pending: PendingEntry[]; text: string; digestFile?: string } {
		const { config } = this.config();
		let pending = listPending(this.snapshot(), { today: this.today, pendingFlagDays: config.pendingFlagDays });
		if (opts.wave === "agent") pending = pending.filter((entry) => entry.claim.origin === "agent");
		if (opts.wave === "migration") pending = pending.filter((entry) => entry.claim.origin === "migration");
		const counts = this.queueCounts();
		const header = pending.length === 0
			? "Nothing waits for review."
			: `${pending.length} claim${pending.length === 1 ? "" : "s"} waiting (${counts.agentProposals} from the agent, ${counts.migrationBacklog} migrated, ${counts.flagged.length} older than ${config.pendingFlagDays} days).`;
		const body = pending.map((entry) => describePending(entry, this.today).join("\n")).join("\n\n");
		const contested = counts.contested.map((entry) => `contested: ${entry.key} @ ${entry.scope} — ${entry.files.join(", ")} (nothing injects for it)`);
		if (pending.length > 12) {
			const file = join(this.paths.migration, `review-${opts.wave ?? "all"}-${this.today}.md`);
			const digest = [`# Pending claims awaiting review — ${this.today}`, ``, `${pending.length} claims (${opts.wave ?? "all waves"}). Read this beside \`/memory approve --wave ${opts.wave ?? "…"}\`, or edit the store files by hand: what is in \`claims/\` is what injects.`, ``, ...pending.map((entry) => describePending(entry, this.today).join("\n"))].join("\n\n") + "\n";
			writeAtomic(file, digest);
			return { pending, digestFile: file, text: [`${header}`, `full listing written to ${file}`, body, ...contested].filter((part) => part !== "").join("\n\n") };
		}
		return { pending, text: [header, body, ...contested].filter((part) => part !== "").join("\n\n") };
	}

	/** R18: a whole batch decided at once. Wording changes stay per claim. */
	reviewWave(action: "approve" | "reject" | "defer", wave: "agent" | "migration"): Outcome & { done: number } {
		const listed = this.reviewList({ wave });
		let done = 0;
		const problems: string[] = [];
		for (const entry of listed.pending) {
			const outcome = this.review(action, entry.claim.key, entry.claim.scope);
			if (outcome.ok) done++;
			else problems.push(outcome.text);
		}
		const verb = action === "approve" ? "approved" : action === "reject" ? "rejected" : "deferred";
		const tail = problems.length > 0 ? `; ${problems.length} refused: ${problems.slice(0, 3).join("; ")}` : "";
		const digest = listed.digestFile ? ` Full listing: ${listed.digestFile}` : "";
		return { ok: problems.length === 0, done, text: `${verb} ${done} pending claim(s) in the ${wave} batch${tail}.${digest}` };
	}

	/** The working-state wave: open items keep their dates; project status stays out. */
	migrateDaily(): Outcome {
		const result = migrateDailyItems(this.paths, { clock: this.clock });
		if ("done" in result) return { ok: false, text: result.reason };
		const lines = [result.total === 0 ? "no open items carried" : `carried ${result.total} open item(s) into ${result.dailyFile}`];
		for (const converted of result.converted) lines.push(`  ${converted.file}: ${converted.added} added, ${converted.skipped} already there`);
		for (const status of result.statusOnly) lines.push(`  ${status.file}: project status, not memory — nothing carried; archived at cutover`);
		for (const refused of result.refused) lines.push(`  left out as status: ${refused.file}: ${refused.item}`);
		return { ok: true, text: lines.join("\n") };
	}

	review(action: "approve" | "reject" | "defer" | "edit", key: string, scope: string, body?: string): Outcome {
		ensureBankDirs(this.paths);
		let outcome;
		try {
			outcome =
				action === "approve"
					? approve(this.paths, key, scope, this.today)
					: action === "reject"
						? rejectClaim(this.paths, key, scope, this.today)
						: action === "defer"
							? deferClaim(this.paths, key, scope, this.today)
							: editPending(this.paths, key, scope, { body });
		} catch (error) {
			return this.refusal(error);
		}
		this.invalidate();
		if (!outcome.ok) return { ok: false, text: outcome.problem };
		const extra = outcome.historyFile ? ` — the previous version is in ${outcome.historyFile}` : "";
		return { ok: true, text: `${outcome.action} ${outcome.claim.key} @ ${outcome.claim.scope}${extra}` };
	}

	/**
	 * A write that refused because a store file holds text the grammar cannot read.
	 * The message names the file and the line, and says the plain fact: nothing was
	 * written, and nothing was deleted.
	 */
	private refusal<T>(error: unknown): Outcome<T> {
		if (error instanceof StoreUnreadable) return { ok: false, text: `refused: ${error.message}` };
		if (error instanceof FileLocked) return { ok: false, text: `refused: ${error.message}` };
		throw error instanceof Error ? error : new Error(String(error));
	}

	// ── Reads ────────────────────────────────────────────────────────────────

	read(path: string, opts: { maxBytes?: number } = {}): Outcome<string> {
		const target = resolve(this.paths.root, path);
		if (target !== this.paths.root && !target.startsWith(`${this.paths.root}/`)) {
			return { ok: false, text: `refused: "${path}" is outside the bank (${this.paths.root})` };
		}
		let stat;
		try {
			stat = statSync(target);
		} catch {
			return { ok: false, text: `no such file in the bank: ${path} — memory_list shows what is there` };
		}
		if (stat.isDirectory()) return { ok: false, text: `"${path}" is a directory — memory_list ${relativeTo(this.paths, target)} lists it` };
		const maxBytes = opts.maxBytes ?? 20_000;
		const text = readFileSync(target, "utf8");
		if (Buffer.byteLength(text, "utf8") <= maxBytes) return { ok: true, text, data: text };
		const clip = text.slice(0, maxBytes);
		const lastLine = clip.lastIndexOf("\n");
		const shown = clip.slice(0, lastLine === -1 ? clip.length : lastLine);
		return { ok: true, text: `${shown}\n\n[…cut at ${shown.length} of ${text.length} characters — read again with a larger limit or by section]`, data: shown };
	}

	/** A bounded tree walk: every file, its size, and how many claims it holds. */
	list(dir = "", limit = 200): Outcome {
		const target = resolve(this.paths.root, dir);
		if (target !== this.paths.root && !target.startsWith(`${this.paths.root}/`)) {
			return { ok: false, text: `refused: "${dir}" is outside the bank` };
		}
		if (!existsSync(target)) return { ok: false, text: `no such directory: ${dir || "."}` };
		const lines: string[] = [];
		const walk = (at: string, depth: number): void => {
			if (lines.length >= limit || depth > 4) return;
			for (const name of safeReaddir(at).sort()) {
				if (name.startsWith(".") || isLockFile(name) || lines.length >= limit) continue;
				const full = join(at, name);
				let stat;
				try {
					stat = statSync(full);
				} catch {
					lines.push(`  ${relativeTo(this.paths, full)} (unreadable)`);
					continue;
				}
				if (stat.isDirectory()) {
					walk(full, depth + 1);
					continue;
				}
				const label = name.endsWith(".md") ? claimCountLabel(full) : name.endsWith(".jsonl") ? `${countLines(full)} lines` : "";
				lines.push(`  ${relativeTo(this.paths, full)} (${[label, `${stat.size} bytes`].filter((part) => part !== "").join(", ")})`);
			}
		};
		walk(target, 0);
		const cut = lines.length >= limit ? `\n  […${limit} entries shown — name a subdirectory for the rest]` : "";
		return { ok: true, text: `${relativeTo(this.paths, target) || "."}: ${lines.length} files\n${lines.join("\n")}${cut}` };
	}

	search(query: string, limit = 12): Outcome<SearchHit[]> {
		const { config } = this.config();
		const take = limit > 0 ? limit : config.searchLimit;
		const snapshot = this.snapshot();
		const documents: { origin: string; label: string; text: string; rank: RankedText }[] = [];

		for (const entry of snapshot.entries) {
			documents.push({
				origin: entry.claim.state === "pending" ? `pending:${entry.claim.origin}` : "claim",
				label: `${entry.claim.key} @ ${entry.claim.scope}`,
				text: entry.claim.body,
				rank: { key: entry.claim.key, scope: entry.claim.scope, kind: entry.claim.kind, body: entry.claim.body, aliases: entry.claim.aliases, tags: entry.claim.tags, links: entry.claim.links },
			});
		}
		for (const file of proseFiles(this.paths.history)) {
			const parsed = parseStore(readFileSync(file, "utf8"), file);
			for (const entry of parsed.entries) {
				documents.push({
					origin: "history",
					label: `${entry.claim.key} @ ${entry.claim.scope} (${entry.claim.supersededAt ?? entry.claim.rejectedAt ?? "?"})`,
					text: entry.claim.body,
					rank: { key: entry.claim.key, scope: entry.claim.scope, kind: entry.claim.kind, body: entry.claim.body, aliases: entry.claim.aliases, tags: entry.claim.tags, links: entry.claim.links },
				});
			}
		}
		for (const file of [...proseFiles(this.paths.dailyArchive), ...proseFiles(this.paths.archive)]) {
			const text = readFileSync(file, "utf8");
			documents.push({ origin: "archive", label: relativeTo(this.paths, file), text, rank: { key: relativeTo(this.paths, file), scope: "archive", kind: "prose", body: text, aliases: [], tags: [], links: [] } });
		}

		const byRank = new Map(documents.map((document) => [document.rank, document]));
		// No score floor here (R32.2). The floor exists because injection spends a
		// budget on claims that only just matched; a search is the human asking, the
		// results are labelled with where they came from, and the count is already
		// bounded by `searchLimit`. A claim matching one of two query words is a
		// candidate here, and is not a claim injected into a turn.
		const scored = bm25(query, documents.map((document) => document.rank), { minShare: 0 });
		const hits: SearchHit[] = scored.slice(0, take).flatMap((hit) => {
			const document = byRank.get(hit.entry);
			return document === undefined ? [] : [{ origin: document.origin, label: document.label, text: document.text, score: hit.score }];
		});
		const header = hits.length === 0 ? `nothing matched "${query}"` : `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}"`;
		const body = hits.map((hit) => `[${hit.origin}] ${hit.label}\n  ${firstLines(hit.text, 3)}`).join("\n");
		return { ok: true, text: [header, body].filter((part) => part !== "").join("\n"), data: hits };
	}

	// ── Health, trial, migration ─────────────────────────────────────────────

	status(cwd: string): Promise<Outcome> {
		const result = this.config();
		const { config, warnings } = result;
		const counts = this.queueCounts();
		const daily = dailyStatus(this.paths, this.today);
		const health = inspectBank(this.snapshot(), this.paths);
		return this.context(cwd).then((context) => {
			const lines = [
				`bank: ${this.paths.root}`,
				`project: ${context.projectId} (root ${context.rootPath})`,
				`config: ${describeConfig(config)}`,
				`source: ${describeConfigSource(result, { file: this.paths.config, present: existsSync(this.paths.config) })}`,
				`claims: ${health.claims.approved} approved, ${health.claims.pending} pending (${counts.agentProposals} agent, ${counts.migrationBacklog} migration); ${health.claims.byKind.rule} rules, ${health.claims.byKind.fact} facts`,
				`daily: ${daily.day === this.today ? "today" : `${describeAge(daily.day, this.today)} old`}, ${daily.open} open items${daily.undated > 0 ? `, ${daily.undated} without their own date` : ""}`,
				`history: ${health.historyFiles} records; archive: ${health.archiveFiles} files`,
				...this.measurement(),
			];
			if (counts.contested.length > 0) lines.push(`contested: ${counts.contested.map((entry) => `${entry.key} @ ${entry.scope}`).join(", ")}`);
			if (health.malformed.length > 0) lines.push(`malformed: ${health.malformed.map((error) => `${error.file}:${error.line} — ${error.message}`).join("\n  ")}`);
			if (health.unwritable.length > 0) {
				lines.push(`cannot read (no write touches these files until it is fixed): ${health.unwritable.map((problem) => `${problem.file}:${problem.line} — ${problem.text}`).join("\n  ")}`);
			}
			if (health.unreadable.length > 0) lines.push(`unreadable: ${health.unreadable.map((entry) => entry.file).join(", ")}`);
			if (health.tempFiles.length > 0) lines.push(`half-written: ${health.tempFiles.join(", ")}`);
			if (health.outsideLinks.length > 0) lines.push(`links out of the bank: ${health.outsideLinks.map((entry) => `${entry.file} (${entry.reason})`).join(", ")}`);
			if (health.unrooted.length > 0) lines.push(`path scopes with no tree (never injected): ${health.unrooted.join(", ")}`);
			for (const issue of daily.issues.slice(0, 5)) lines.push(`daily damage: ${issue.file}:${issue.line} — ${issue.message}`);
			for (const warning of warnings) lines.push(`config: ${warning}`);
			return { ok: true, text: lines.join("\n") };
		});
	}

	doctor(): Outcome {
		const health = inspectBank(this.snapshot(), this.paths);
		const progress = migrationProgress(this.paths);
		const trial = trialReport(this.paths, { today: this.today });
		const lines = [
			isWellFormed(health)
				? "the bank is well formed"
				: "the bank needs attention",
			`  ${health.claims.approved} approved, ${health.claims.pending} pending, ${health.historyFiles} history records, ${health.archiveFiles} archive files`,
		];
		if (health.malformed.length > 0) lines.push(`  ${health.malformed.length} malformed entries: ${health.malformed.map((error) => `${error.file}:${error.line}`).join(", ")}`);
		if (health.unwritable.length > 0) {
			lines.push(`  ${health.unwritable.length} line(s) no writer can reproduce — memory_propose and /memory approve|reject|defer|edit refuse until it is fixed:`);
			for (const problem of health.unwritable) lines.push(`    ${problem.file}:${problem.line}: ${problem.text}`);
			lines.push("    the text is still on disk and nothing was deleted; give it a heading of its own, or move it to a file of its own");
		}
		if (health.contested.length > 0) lines.push(`  ${health.contested.length} contested identities: ${health.contested.map((entry) => `${entry.key} @ ${entry.scope}`).join(", ")}`);
		if (health.unreadable.length > 0) lines.push(`  ${health.unreadable.length} unreadable stores`);
		if (health.tempFiles.length > 0) lines.push(`  ${health.tempFiles.length} half-written files: ${health.tempFiles.join(", ")}`);
		if (health.outsideLinks.length > 0) lines.push(`  ${health.outsideLinks.length} links leave the bank: ${health.outsideLinks.map((entry) => entry.file).join(", ")}`);
		lines.push(`  migration: ${progress.todo} of ${progress.total} source files still to draft${progress.backup ? "" : " (no backup recorded)"}`);
		lines.push(`  measure: ${trial.turns} turns recorded, median ${trial.medianTokens} tokens${trial.newestAt === undefined ? "" : `, newest ${trial.newestAt}`}`);
		const errors = readErrorMetrics(this.paths).slice(-3);
		lines.push(errors.length === 0
			? "  errors: none recorded"
			: `  errors: ${errors.map((error) => `${error.at} ${error.where}: ${error.message}`).join("\n    ")}`);
		return { ok: isWellFormed(health), text: lines.join("\n") };
	}

	flag(key: string, kind: "stale" | "rival", sessionId: string): Outcome {
		const snapshot = this.snapshot();
		const claim = snapshot.claims.find((candidate) => candidate.key === key);
		if (!claim) return { ok: false, text: `no claim "${key}" in the bank — memory_search finds what is there` };
		try {
			const record = recordFlag(this.paths, { key, kind, claim: claim.body, scope: claim.scope, session: sessionId }, this.clock);
			return { ok: true, text: `flagged ${key} as ${kind} at ${record.at} — /memory trial counts it` };
		} catch (error) {
			return { ok: false, text: `refused: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	reportTrial(days?: number, last?: number): Outcome<TrialReport> {
		const report = trialReport(this.paths, { today: this.today, days, last });
		return { ok: report.go, text: formatTrialReport(report), data: report };
	}

	baseline(opts: { days?: number; marker?: string; sessionsDir?: string }): Outcome {
		const sessionsDir = opts.sessionsDir ?? join(this.paths.root, "..", "agent", "sessions");
		const result = computeBaseline({ paths: this.paths, sessionsDir, days: opts.days ?? 14, today: this.today, marker: opts.marker });
		if (!result.ok) return { ok: false, text: `baseline: ${result.reason}` };
		writeBaseline(this.paths, result.baseline!);
		return { ok: true, text: `baseline: median ${result.baseline!.medianTokens} tokens per turn from ${result.baseline!.samples} blocks marked "${result.baseline!.marker}" across ${result.filesScanned} session files, ${result.baseline!.from} to ${result.baseline!.to} — written to ${join(this.paths.metrics, "baseline.json")}` };
	}

	flagsList(): Outcome {
		const flags = readFlags(this.paths);
		if (flags.length === 0) return { ok: true, text: "no claims have been flagged stale or rival" };
		return { ok: true, text: flags.map((flag) => `${flag.at} ${flag.key} @ ${flag.scope} — ${flag.kind}: ${flag.claim}`).join("\n") };
	}

	// ── Migration ────────────────────────────────────────────────────────────

	async migrateBackup(exec?: ExecFn): Promise<Outcome<{ file: string }>> {
		ensureBankDirs(this.paths);
		try {
			const backup = await backupBank(this.paths, { exec, day: this.today, clock: this.clock });
			const state = recordBackup(this.paths, { file: backup.file, entries: backup.entries }, this.clock);
			void state;
			return { ok: true, text: `backup written and listed back: ${backup.file} (${backup.entries} files). Every other migration step is unlocked.`, data: backup };
		} catch (error) {
			return { ok: false, text: `backup refused: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	migratePlan(): Outcome {
		const planned = planMigration(this.paths, { clock: this.clock });
		const state = savePlan(this.paths, planned);
		const lines = [`planned ${Object.keys(state.files).length} source files in waves: ${state.waves.join(", ")}`];
		if (planned.retired.length > 0) lines.push(`retired old entries, not proposed: ${planned.retired.join(", ")}`);
		if (planned.unreadable.length > 0) lines.push(`unreadable: ${planned.unreadable.map((entry) => entry.file).join(", ")}`);
		if (Object.keys(state.files).length === 0) lines.push("nothing to migrate: no knowledge/ or core/ files were found");
		return { ok: true, text: lines.join("\n"), data: state };
	}

	migrateStatus(): Outcome {
		return { ok: true, text: formatMigrationProgress(migrationProgress(this.paths)) };
	}

	/** R38: one file's brief, or a batch of the next files in a wave. */
	migrateDraft(opts: { wave?: string; file?: string; batch?: number } = {}): Outcome {
		if (opts.batch !== undefined && opts.batch > 1) {
			const queue = draftQueue(this.paths, { wave: opts.wave, batch: opts.batch });
			if ("done" in queue) return { ok: false, text: queue.reason };
			const lines = queue.map((todo) => `  ${todo.file} (wave ${todo.wave}, ${todo.entries} entry${todo.entries === 1 ? "" : "s"})`);
			return {
				ok: true,
				text: `batch of ${queue.length} file(s), in wave order:\n${lines.join("\n")}\n\nDraft one at a time: /memory migrate draft --file <name>. Record each one with /memory migrate drafted <file> <n>.`,
			};
		}
		const brief = nextDraft(this.paths, { wave: opts.wave, file: opts.file });
		if ("done" in brief) return { ok: false, text: brief.reason };
		const body = brief.entries.map((entry) => `## ${entry.key}\n${entry.body}`).join("\n\n");
		const retired = brief.retired.length > 0 ? `\nretired entries (archive them, do not propose them): ${brief.retired.join(", ")}` : "";
		return { ok: true, text: `${brief.instructions}\n\n--- the file, as it is today ---\n${body}${retired}` };
	}

	/** Draft a whole wave in one pass, through the same gate as a hand-written proposal. */
	migrateApply(opts: { wave?: string; all?: boolean } = {}): Outcome {
		let result;
		try {
			result = applyMigration(this.paths, { ...opts, clock: this.clock });
		} catch (error) {
			return this.refusal(error);
		}
		if ("done" in result) return { ok: false, text: result.reason };
		const lines = [
			`wave ${result.wave}: ${result.proposed.length} claim(s) proposed from ${result.files.length} file(s). None of them inject until you approve them (D9).`,
			`  files: ${result.files.join(", ")}`,
		];
		if (result.refused.length > 0) {
			lines.push(`  ${result.refused.length} entry(ies) not proposed:`);
			for (const refusal of result.refused.slice(0, 15)) lines.push(`    ${refusal.file} ${refusal.key}: ${refusal.problem}`);
			if (result.refused.length > 15) lines.push(`    …and ${result.refused.length - 15} more: /memory migrate status`);
		}
		lines.push("Next: /memory review --wave migration (the full listing is written beside it), then /memory approve --wave migration.");
		return { ok: true, text: lines.join("\n"), data: result };
	}

	migrateDrafted(file: string, proposals: number): Outcome {
		const result = markDrafted(this.paths, file, proposals, this.clock);
		return result.ok ? { ok: true, text: `drafted ${result.file} (${proposals} proposals)` } : { ok: false, text: result.problem };
	}

	migrateCutover(): Outcome {
		const result = cutoverSources(this.paths, this.clock);
		return result.ok
			? { ok: true, text: `cutover: ${result.archived.length} source files moved to the read-only archive${result.skipped.length > 0 ? `; ${result.skipped.length} were already gone` : ""}` }
			: { ok: false, text: `cutover refused: ${result.problem}` };
	}

	migrationState(): MigrationState | undefined {
		return readState(this.paths);
	}
}

export function createBank(opts: BankOptions = {}): Bank {
	return new Bank(opts);
}

/** Nothing in the bank needs a human's attention before a write can be trusted. */
function isWellFormed(health: BankHealth): boolean {
	return health.malformed.length === 0 && health.contested.length === 0 && health.unreadable.length === 0 && health.unwritable.length === 0 && health.tempFiles.length === 0 && health.outsideLinks.length === 0;
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function proseFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of safeReaddir(dir)) {
		const full = join(dir, name);
		try {
			if (statSync(full).isDirectory()) out.push(...proseFiles(full));
			else if (name.endsWith(".md")) out.push(full);
		} catch {
			continue;
		}
	}
	return out;
}

function relativeTo(paths: BankPaths, file: string): string {
	return file === paths.root ? "" : file.startsWith(`${paths.root}/`) ? file.slice(paths.root.length + 1) : file;
}

function claimCountLabel(file: string): string {
	try {
		const parsed = parseStore(readFileSync(file, "utf8"), file);
		return parsed.entries.length === 0
			? "no claims"
			: `${parsed.entries.filter((entry) => entry.claim.state === "approved").length} approved, ${parsed.entries.filter((entry) => entry.claim.state === "pending").length} pending`;
	} catch {
		return "malformed";
	}
}

function countLines(file: string): number {
	try {
		return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").length;
	} catch {
		return -1;
	}
}

function firstLines(text: string, count: number): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(0, count)
		.join(" ");
}

async function defaultGitProbe(cwd: string): Promise<{ root?: string; remote?: string }> {
	const { execFile } = await import("node:child_process");
	const run = (args: string[]): Promise<string> =>
		new Promise((fulfill) => {
			execFile("git", args, { cwd }, (error, stdout) => fulfill(error ? "" : String(stdout).trim()));
		});
	const root = await run(["rev-parse", "--show-toplevel"]);
	const remote = await run(["remote", "get-url", "origin"]);
	return { root: root === "" ? undefined : root, remote: remote === "" ? undefined : remote };
}
