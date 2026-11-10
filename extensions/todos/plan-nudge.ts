/**
 * The plan nudge: ask once when the agent starts editing files with no task list.
 *
 * `README.md` — the injected block only speaks when there is a list to speak
 * about, and the quiet-turns nudge stays silent when the list is empty, so a
 * session that never plans is never told to plan. The rule in the global
 * `AGENTS.md` is the only thing asking for `TodoCreate`, and a file the model
 * skimmed at start is not pressure.
 *
 * This closes that gap at the earliest moment "this is multi-step work" is
 * decidable: after `PLAN_NUDGE_THRESHOLD` calls to a tool that changes files.
 * Before that, pi offers only `before_agent_start`, which runs before any
 * thinking — there is no "the agent decided to work" hook to listen for. After
 * the fact (deriving tasks from the tool stream) produces a transcript, not a
 * plan: the steps arrive once they are done, with no acceptance criteria, and
 * the list can no longer steer the work it describes.
 *
 * So it asks, once, and the decision stays with the model — a plan the
 * executing model wrote is a plan it keeps.
 */

/**
 * Turns containing a file change, with no task list, before the nudge rides along.
 *
 * Counted in turns rather than tool calls because that is the failure this
 * exists for: a long session losing track. A call-count trigger fires on
 * *busywork* instead — measured on two live sessions, a three-file job done in
 * one assistant turn (three writes issued in one batch, `pytest` green 40
 * seconds later) was nudged, and correctly ignored, because by the rule the
 * user's own `AGENTS.md` states — skip one-off work — no plan was warranted.
 * Turn-spanning work is the shape that actually warrants one.
 */
export const PLAN_NUDGE_THRESHOLD = 3;

/**
 * Tools that change files. `read`, `find`, `grep` and `ls` are excluded so a
 * session that is only answering a question never sees the nudge; `bash` and
 * `powershell` are included because that is where a real refactor happens
 * (`git mv`, `sed`, a generator) — the cost is that a three-command
 * investigation can trigger one ask, which the reminder's own last sentence is
 * written to absorb.
 */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
	"edit",
	"write",
	"bash",
	"powershell",
]);

export const PLAN_NUDGE_REMINDER = `<system-reminder>
You have been changing files for ${PLAN_NUDGE_THRESHOLD} separate turns with no task list. Call TodoCreate with tasks: [] for the work that remains — acceptance criteria in each description, ordering in addBlockedBy — then TodoUpdate a task to in_progress before starting it and completed once it is verified. If the rest is one small change, say so in one line and carry on without a list.
</system-reminder>`;

/**
 * Counts file-changing tool calls for one session and grants a single nudge.
 *
 * Every method is synchronous over in-memory state, so the whole rule is a
 * table: what counts, what does not, and when the ask is spent.
 */
export class PlanNudge {
	/** Turn on which a counted tool call was last seen, so a turn counts once. */
	private lastTurn = -1;
	private turns = 0;
	private asked = false;
	private enabled: boolean;

	/** Off is a config choice (`planNudge: false`), not an absence of work. */
	constructor(enabled = true) {
		this.enabled = enabled;
	}

	/**
	 * Record a tool result and say whether the nudge rides on it.
	 *
	 * `turn` is the session's turn counter: three parallel writes in one batch
	 * are one turn of work, which is why the turn number rather than the call
	 * moves the count.
	 *
	 * A non-empty list answers the question, so it also spends the ask: once the
	 * model has a list, nothing is left to remind it about. That is also the only
	 * way the nudge re-arms — the list is emptied (auto-clear, `/todos clear`),
	 * work starts again, and the ask is available once more.
	 */
	note(toolName: string, hasTasks: boolean, turn: number): boolean {
		if (!this.enabled) return false;
		if (hasTasks) {
			this.turns = 0;
			this.lastTurn = -1;
			this.asked = false;
			return false;
		}
		if (!FILE_MUTATING_TOOLS.has(toolName)) return false;
		if (turn !== this.lastTurn) {
			this.turns++;
			this.lastTurn = turn;
		}
		if (this.asked || this.turns < PLAN_NUDGE_THRESHOLD) return false;
		this.asked = true;
		return true;
	}

	/** Forget the session — called at `session_start`, where the config is re-read. */
	reset(enabled = this.enabled): void {
		this.enabled = enabled;
		this.turns = 0;
		this.lastTurn = -1;
		this.asked = false;
	}
}
