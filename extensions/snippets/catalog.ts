import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { displaySafe } from "./display-safe.ts";
import { assertTerminalSafe, parsePlaceholderTemplate, type ParsedPlaceholderTemplate } from "./placeholders.ts";

export const DEFAULT_SNIPPET_DIRECTORY = join(homedir(), ".pi", "agent", "snippets");

export type CatalogState = "ready" | "missing" | "empty" | "unavailable";
export type CatalogDiagnosticCode = "directory-missing" | "directory-read" | "file-read" | "invalid-snippet";

export interface CatalogDiagnostic {
	readonly code: CatalogDiagnosticCode;
	readonly message: string;
	readonly filename?: string;
}

export interface CatalogSnippet {
	/** Stable catalog identity. Display names are allowed to collide. */
	readonly filename: string;
	readonly name: string;
	readonly description?: string;
	readonly body: string;
	readonly template: ParsedPlaceholderTemplate;
}

export interface SnippetCatalog {
	readonly state: CatalogState;
	readonly directory: string;
	readonly snippets: readonly CatalogSnippet[];
	readonly diagnostics: readonly CatalogDiagnostic[];
}

export interface LoadSnippetCatalogOptions {
	readonly directory?: string;
}

type Metadata = Record<string, unknown>;

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function errorMessage(error: unknown): string {
	return displaySafe(error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function freezeDiagnostic(diagnostic: CatalogDiagnostic): CatalogDiagnostic {
	return Object.freeze(diagnostic);
}

function snapshot(
	state: CatalogState,
	directory: string,
	snippets: readonly CatalogSnippet[],
	diagnostics: readonly CatalogDiagnostic[],
): SnippetCatalog {
	return Object.freeze({
		state,
		directory,
		snippets: Object.freeze(snippets.slice()),
		diagnostics: Object.freeze(diagnostics.map(freezeDiagnostic)),
	});
}

function normalizedSource(content: string): string {
	const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
	return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * parseFrontmatter intentionally treats an unclosed opening delimiter as body
 * text, accepts closing lines that merely start with "---", and trims bodies.
 * Snippet files use exact delimiter lines. The body starts after only the exact
 * closing delimiter's newline, so any following blank separator is body text.
 */
function extractBody(normalized: string): string {
	if (!normalized.startsWith("---")) return normalized;

	const openingEnd = normalized.indexOf("\n");
	if (openingEnd === -1 || normalized.slice(0, openingEnd) !== "---") {
		throw new Error("frontmatter opening delimiter must be a line containing only ---");
	}

	let lineStart = openingEnd + 1;
	while (lineStart <= normalized.length) {
		const lineEnd = normalized.indexOf("\n", lineStart);
		const line = normalized.slice(lineStart, lineEnd === -1 ? normalized.length : lineEnd);
		if (line.startsWith("---")) {
			if (line !== "---") {
				throw new Error("frontmatter closing delimiter must be a line containing only ---");
			}
			return lineEnd === -1 ? "" : normalized.slice(lineEnd + 1);
		}
		if (lineEnd === -1) break;
		lineStart = lineEnd + 1;
	}

	throw new Error("frontmatter is missing a closing --- delimiter line");
}

function validateMetadata(value: unknown): Metadata {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("frontmatter metadata must be a YAML mapping");
	}
	return value as Metadata;
}

function optionalString(metadata: Metadata, key: "name" | "description"): string | undefined {
	if (!Object.prototype.hasOwnProperty.call(metadata, key)) return undefined;
	const value = metadata[key];
	if (typeof value !== "string") throw new Error(`frontmatter ${key} must be a string`);
	assertTerminalSafe(value, `frontmatter ${key}`);
	return displaySafe(value);
}

function parseCatalogSnippet(filename: string, content: string): CatalogSnippet {
	assertTerminalSafe(filename, "snippet filename");
	assertTerminalSafe(content, `snippet ${JSON.stringify(filename)} source`);
	const normalized = normalizedSource(content);
	const body = extractBody(normalized);

	const parsed = parseFrontmatter(normalized);
	const metadata = validateMetadata(parsed.frontmatter as unknown);
	if (body.trim().length === 0) throw new Error("snippet has an empty body");

	const name = optionalString(metadata, "name") ?? displaySafe(basename(filename, ".md"));
	const description = optionalString(metadata, "description");
	const template = parsePlaceholderTemplate(body);
	return Object.freeze({ filename, name, description, body, template });
}

/**
 * Reads a fresh, immutable snapshot of directly contained Markdown files.
 * The function never creates or mutates the directory and ignores directories,
 * non-.md entries, and symlinks reported by the filesystem.
 */
export async function loadSnippetCatalog(options: LoadSnippetCatalogOptions = {}): Promise<SnippetCatalog> {
	const directory = options.directory ?? DEFAULT_SNIPPET_DIRECTORY;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return snapshot(
				"missing",
				directory,
				[],
				[
					{
						code: "directory-missing",
						message: `Snippet directory does not exist: ${displaySafe(directory)}`,
					},
				],
			);
		}
		return snapshot(
			"unavailable",
			directory,
			[],
			[
				{
					code: "directory-read",
					message: `Unable to read snippet directory ${displaySafe(directory)}: ${errorMessage(error)}`,
				},
			],
		);
	}

	const candidates = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.sort((left, right) => compareText(left.name, right.name));
	if (candidates.length === 0) return snapshot("empty", directory, [], []);

	const snippets: CatalogSnippet[] = [];
	const diagnostics: CatalogDiagnostic[] = [];
	for (const entry of candidates) {
		let content: string;
		try {
			content = await readFile(join(directory, entry.name), "utf8");
		} catch (error) {
			diagnostics.push({
				code: "file-read",
				filename: displaySafe(entry.name),
				message: `Unable to read snippet ${displaySafe(entry.name)}: ${errorMessage(error)}`,
			});
			continue;
		}

		try {
			snippets.push(parseCatalogSnippet(entry.name, content));
		} catch (error) {
			diagnostics.push({
				code: "invalid-snippet",
				filename: displaySafe(entry.name),
				message: `Invalid snippet ${displaySafe(entry.name)}: ${errorMessage(error)}`,
			});
		}
	}

	snippets.sort((left, right) => compareText(left.name, right.name) || compareText(left.filename, right.filename));
	return snapshot("ready", directory, snippets, diagnostics);
}
