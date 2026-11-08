/** Bounded local recovery for cooperating extension writes. Not an external backup. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isMarkdownPath, resolveBankPath, type BankPath } from "./paths.js";
export interface RevisionConfig { enabled: boolean; maxPerFile: number; maxTotalBytes: number }
export const DEFAULT_REVISIONS: RevisionConfig = { enabled: false, maxPerFile: 10, maxTotalBytes: 10 * 1024 * 1024 };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
// Independent of the current retention budget: lowering that budget must not
// turn a previously valid snapshot into corruption before pruning can run.
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024; // maximum supported budget
const ID = /^[a-z0-9]+-[0-9a-f-]{36}$/;
export function internalPath(rel: string): boolean { return /^(?:\.revisions|\.write-locks)(?:\/|$)/i.test(rel); }
export interface RevisionInfo { id: string; path: string; createdAt: string; sha256: string; bytes: number }
interface Stored extends RevisionInfo { rel: string; full: string; content: string }
type AtomicWrite = (full: string, content: string) => void;
type AcquireLock = (full: string) => Promise<(() => void) | null>;

export class RevisionStore {
	constructor(private root: string, private atomicWrite: AtomicWrite, private acquireLock: AcquireLock) {}
	private safe(rel: string): BankPath {
		const checked = resolveBankPath(this.root, rel);
		if (!checked) throw new Error("Unsafe revision/target path (symlink traversal is not supported)");
		// Compose from the *configured* root, not the realpath one: on macOS a temp
		// root (/var/...) and its resolved form (/private/var/...) name the same file
		// but fail each other's containment check on the way back in.
		return { rel: checked.rel, full: path.resolve(this.root, checked.rel) };
	}
	private target(file: string) {
		const target = this.safe(file);
		if (!target.rel || internalPath(target.rel)) throw new Error("Internal recovery/lock files cannot be memory write targets");
		return target;
	}
	private current(full: string): string | null {
		try { return fs.readFileSync(full, "utf8"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}
	private inventory(): { entries: Stored[]; errors: string[] } {
		const entries: Stored[] = [], errors: string[] = [];
		const dir = this.safe(".revisions").full;
		let groups: fs.Dirent[];
		try { groups = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries, errors };
			throw error;
		}
		for (const group of groups) {
			if (group.name.startsWith(".")) continue;
			if (!group.isDirectory() || !/^[0-9a-f]{64}$/.test(group.name)) { errors.push(`Unexpected revision entry: ${group.name}`); continue; }
			const folder = this.safe(`.revisions/${group.name}`).full;
			for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
				if (file.name.startsWith(".")) continue;
				try {
					const id = file.name.replace(/\.json$/, "");
					if (!file.isFile() || !file.name.endsWith(".json") || !ID.test(id)) throw new Error("Unexpected revision filename/type");
					const rel = `.revisions/${group.name}/${file.name}`, entry = this.safe(rel), full = entry.full;
					const bytes = fs.statSync(full).size;
					if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds supported read limit");
					const row = JSON.parse(fs.readFileSync(full, "utf8"));
					if (row.schemaVersion !== 1 || row.id !== id || typeof row.path !== "string" || path.isAbsolute(row.path) || path.posix.isAbsolute(row.path) ||
						path.normalize(row.path).split(path.sep).join("/") !== row.path || digest(row.path) !== group.name || typeof row.content !== "string" || row.sha256 !== digest(row.content) ||
						typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) throw new Error("Invalid revision metadata or checksum");
					// Older snapshots may use an accepted case/Unicode alias. Verify their
					// original group hash above, but expose/group them by current disk identity.
					entries.push({ id, path: this.target(row.path).rel, createdAt: row.createdAt, sha256: row.sha256, content: row.content, rel: entry.rel, full, bytes });
				} catch (error) { errors.push(`${group.name}/${file.name}: ${String(error)}`); }
			}
		}
		return { entries, errors };
	}
	list(file: string | null, _config: RevisionConfig) {
		const rel = file === null ? null : this.target(file).rel;
		const { entries, errors } = this.inventory();
		return {
			revisions: entries.filter((row) => rel === null || row.path === rel).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
				.map(({ content: _content, full: _full, ...info }) => info),
			bytes: entries.reduce((n, row) => n + row.bytes, 0), errors,
		};
	}
	private prune(entries: Stored[], config: RevisionConfig, protectedId: string): void {
		const order = [...entries].sort((a, b) => Number(b.id === protectedId) - Number(a.id === protectedId) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
		const counts = new Map<string, number>(), keep = new Set<string>();
		let total = 0;
		for (const row of order) {
			if ((counts.get(row.path) ?? 0) >= config.maxPerFile) continue;
			keep.add(row.full); counts.set(row.path, (counts.get(row.path) ?? 0) + 1); total += row.bytes;
		}
		for (const row of [...order].reverse()) {
			if (total <= config.maxTotalBytes) break;
			if (row.id !== protectedId && keep.delete(row.full)) total -= row.bytes;
		}
		if (total > config.maxTotalBytes) throw new Error("Current text cannot be backed up within revision byte budget");
		for (const row of entries) if (!keep.has(row.full)) {
			fs.unlinkSync(row.full);
			try { fs.rmdirSync(path.dirname(row.full)); } catch { /* other revisions remain */ }
		}
	}
	/** Always compose relative paths: `.full` may carry a resolved root (macOS
	 * /var -> /private/var), and re-resolving an absolute real path against the
	 * configured root would read as an escape. */
	private folderRel(rel: string): string { return `.revisions/${digest(rel)}`; }
	private entryRel(rel: string, id: string): string { return `${this.folderRel(rel)}/${id}.json`; }
	private capture(rel: string, content: string, config: RevisionConfig): string {
		const { entries, errors } = this.inventory();
		if (errors.length) throw new Error(`Recovery store needs inspection: ${errors[0]}`);
		const sha256 = digest(content);
		const latest = entries.filter((r) => r.path === rel).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
		if (latest?.sha256 === sha256) { this.prune(entries, config, latest.id); return latest.id; }
		const id = `${Date.now().toString(36)}-${randomUUID()}`, createdAt = new Date().toISOString();
		const record = { schemaVersion: 1, id, path: rel, createdAt, sha256, content };
		const text = JSON.stringify(record) + "\n", bytes = Buffer.byteLength(text, "utf8");
		if (bytes > config.maxTotalBytes) throw new Error("Refusing overwrite: previous text exceeds the revision byte budget; raise revisions.maxTotalBytes");
		const folder = this.safe(this.folderRel(rel)).full;
		fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		const entry = this.safe(this.entryRel(rel, id)), full = entry.full;
		this.atomicWrite(full, text);
		this.prune([...entries, { id, path: rel, createdAt, sha256, content, rel: entry.rel, full, bytes }], config, id);
		return id;
	}
	private async locked<T>(run: () => T): Promise<T> {
		const release = await this.acquireLock(this.safe(".revisions").full);
		if (!release) throw new Error("Recovery store is locked; inspect abandoned locks rather than stealing one");
		try { return run(); } finally { release(); }
	}
	/** Caller holds the target's ordinary write lock. Keep backup + commit under
	 * the store lock too, so another cooperating writer cannot prune between them.
	 */
	async write(file: string, content: string, config: RevisionConfig): Promise<void> {
		const target = this.target(file);
		if (!config.enabled || !isMarkdownPath(target.rel)) { this.atomicWrite(target.full, content); return; }
		await this.locked(() => {
			const previous = this.current(target.full);
			if (previous === content) return;
			if (previous !== null) this.capture(target.rel, previous, config);
			this.atomicWrite(target.full, content);
		});
	}
	/** Explicit operator action. Always back up current bytes, even if automatic
	 * history was disabled. The requested snapshot may be pruned after it is read.
	 */
	async restore(file: string, id: string, config: RevisionConfig) {
		const target = this.target(file);
		if (!isMarkdownPath(target.rel) || !ID.test(id)) throw new Error("Restore requires a Markdown target and an exact revision ID");
		return this.locked(() => {
			const { entries, errors } = this.inventory();
			if (errors.length) throw new Error(`Recovery store needs inspection: ${errors[0]}`);
			const snapshot = entries.find((row) => row.path === target.rel && row.id === id);
			if (!snapshot) throw new Error("Revision not found for this exact file");
			const previous = this.current(target.full);
			if (previous === snapshot.content) return { restored: false, backupId: null, content: snapshot.content };
			const backupId = previous === null ? null : this.capture(target.rel, previous, config);
			fs.mkdirSync(path.dirname(target.full), { recursive: true });
			this.atomicWrite(target.full, snapshot.content);
			return { restored: true, backupId, content: snapshot.content };
		});
	}
}
