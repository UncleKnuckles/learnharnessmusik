/**
 * Russian names and statements for graph nodes (music-study fork).
 *
 * The graph keeps its canonical names and statements (the extractor and
 * the auditor match new findings against them, so they never change). This
 * module keeps a side file, data/graph/translations-ru.json, with a Russian
 * name and statement per node. The graph view shows those when the
 * interface is Russian, and search matches both languages.
 *
 * Missing or stale translations are produced in the background by the
 * Cheap model (the extractor's slot), a batch at a time, one run at a time.
 * A node's entry records a hash of the text it was translated from, so an
 * edited node is translated again.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import type { GraphNode } from "../core/contracts/graph.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { engineForRole } from "./chat-handler.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

export type NodeTranslation = { name: string; statement: string };
type StoredTranslation = NodeTranslation & { src: string };
type TranslationFile = { version: 1; nodes: Record<string, StoredTranslation> };
export type TranslationInput = { id: string; name: string; statement: string };
export type TranslateBatch = (batch: TranslationInput[], signal?: AbortSignal) => Promise<Array<TranslationInput>>;

export const TRANSLATION_BATCH = 20;
const RETRY_AFTER_MS = 3 * 60_000;

export type TranslationsView = {
	translations: Record<string, NodeTranslation>;
	/** Nodes still waiting for a (fresh) translation. */
	pending: number;
	running: boolean;
	error: string | null;
};

const file = () => path.join(PATHS.graph, "translations-ru.json");

export function sourceHash(node: Pick<GraphNode, "name" | "statement">): string {
	return createHash("sha256").update(`${node.name}\n${node.statement}`).digest("hex").slice(0, 16);
}

export function readTranslationFile(filePath = file()): TranslationFile {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TranslationFile>;
		if (raw && raw.version === 1 && raw.nodes && typeof raw.nodes === "object") return { version: 1, nodes: raw.nodes };
	} catch {}
	return { version: 1, nodes: {} };
}

function writeTranslationFile(data: TranslationFile, filePath = file()): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileAtomicSync(filePath, JSON.stringify(data));
}

/** Nodes whose Russian entry is missing or was made from older text. */
export function pendingNodes(nodes: readonly GraphNode[], data: TranslationFile): GraphNode[] {
	return nodes.filter((node) => data.nodes[node.id]?.src !== sourceHash(node));
}

/** Text that is already Russian needs no model call. */
export function looksRussian(text: string): boolean {
	// Original terms in parentheses ("Период (Periode)") do not count.
	const letters = text.replace(/\([^)]*\)/g, " ").match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return true;
	const cyrillic = letters.filter((ch) => /\p{Script=Cyrillic}/u.test(ch)).length;
	return cyrillic / letters.length > 0.6;
}

export const TRANSLATION_PROMPT = `You translate nodes of a music student's knowledge graph into Russian.
Each node has a short "name" (a glossary-style handle) and a "statement" (one precise sentence).
Rules:
- Write natural Russian as used in Russian music-theory textbooks.
- In the name, keep the original technical term in parentheses after the Russian one, e.g. "Период (Periode)", "Тип Fortspinnung (Fortspinnungstypus)". German grammar topics keep the German example words as they are.
- Keep chord and function symbols (T, S, D, D7, Tp, DD), note names, figured-bass numbers, bar numbers, formulas, letters such as A-A-B, and quoted German words unchanged.
- Do not add or drop information. If a field is already Russian, return it unchanged.
Answer with JSON only: an array of {"id","name","statement"} objects, one per input node, same ids.`;

/** Pull the JSON array out of a model answer (tolerates code fences and chatter). */
export function parseTranslationAnswer(text: string, ids: ReadonlySet<string>): TranslationInput[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) throw new Error("The model answered without a JSON array.");
	const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
	if (!Array.isArray(parsed)) throw new Error("The model answer is not an array.");
	const out: TranslationInput[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const { id, name, statement } = item as Record<string, unknown>;
		if (typeof id !== "string" || !ids.has(id) || typeof name !== "string" || typeof statement !== "string") continue;
		if (!name.trim()) continue;
		out.push({ id, name: name.trim().slice(0, 300), statement: statement.trim().slice(0, 4000) });
	}
	return out;
}

/** The default batch translator: the Cheap model through the extractor's role. */
export const modelTranslateBatch: TranslateBatch = async (batch, signal) => {
	const engine = engineForRole("extractor");
	if (!engine) throw new Error("Pick a Cheap model in Settings → Agent to translate node names.");
	if (!providerKeyPresent(engine.model.provider)) throw new Error(`Node translation needs the ${engine.model.provider} key or sign-in for the Cheap model.`);
	const messages: Message[] = [{
		role: "user",
		content: [{ type: "text", text: JSON.stringify(batch.map(({ id, name, statement }) => ({ id, name, statement }))) }],
		timestamp: Date.now(),
	}];
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt: TRANSLATION_PROMPT, messages }), { signal } as never);
	for await (const event of stream) {
		if (event.type === "done") {
			const text = event.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
			return parseTranslationAnswer(text, new Set(batch.map((node) => node.id)));
		}
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "The Cheap model failed.");
	}
	throw new Error("The Cheap model stream ended without a result.");
};

type Deps = {
	readNodes: () => GraphNode[];
	translate: TranslateBatch;
	filePath?: string;
	now?: () => number;
};

/** One translation worker. Exported as a factory so tests run it in isolation. */
export function createNodeTranslator(deps: Deps) {
	let running: Promise<void> | null = null;
	let error: string | null = null;
	let retryAt = 0;
	const now = deps.now ?? Date.now;

	async function run(): Promise<void> {
		for (;;) {
			const data = readTranslationFile(deps.filePath);
			const nodes = deps.readNodes();
			const todo = pendingNodes(nodes, data);
			if (todo.length === 0) break;
			// Already-Russian nodes are copied without a model call.
			const russian = todo.filter((node) => looksRussian(node.name) && looksRussian(node.statement));
			for (const node of russian) data.nodes[node.id] = { name: node.name, statement: node.statement, src: sourceHash(node) };
			const batch = todo.filter((node) => !russian.includes(node)).slice(0, TRANSLATION_BATCH);
			if (batch.length > 0) {
				const answer = await deps.translate(batch.map(({ id, name, statement }) => ({ id, name, statement })));
				const byId = new Map(batch.map((node) => [node.id, node]));
				let applied = 0;
				for (const item of answer) {
					const node = byId.get(item.id);
					if (!node) continue;
					data.nodes[node.id] = { name: item.name, statement: item.statement || node.statement, src: sourceHash(node) };
					applied++;
				}
				if (applied === 0) throw new Error("The model returned no usable translations.");
			}
			// Drop entries of deleted nodes while we are here.
			const live = new Set(nodes.map((node) => node.id));
			for (const id of Object.keys(data.nodes)) if (!live.has(id)) delete data.nodes[id];
			writeTranslationFile(data, deps.filePath);
			if (batch.length === 0) break;
		}
	}

	/** Start a run when work is waiting (single-flight, with a retry pause after a failure). */
	function kick(): void {
		if (running || now() < retryAt) return;
		running = run().then(() => { error = null; }, (e: unknown) => {
			error = e instanceof Error ? e.message : String(e);
			retryAt = now() + RETRY_AFTER_MS;
		}).finally(() => { running = null; });
	}

	function view(start = true): TranslationsView {
		const data = readTranslationFile(deps.filePath);
		const nodes = deps.readNodes();
		const pending = pendingNodes(nodes, data).length;
		if (start && pending > 0) kick();
		const translations: Record<string, NodeTranslation> = {};
		for (const node of nodes) {
			const entry = data.nodes[node.id];
			// A stale entry still beats nothing while the fresh one is made.
			if (entry) translations[node.id] = { name: entry.name, statement: entry.statement };
		}
		return { translations, pending, running: running !== null, error };
	}

	return { view, kick, idle: () => running ?? Promise.resolve() };
}

/** The ledger holds one line per encounter; the FIRST line of an id defines
 *  its name and statement (later lines only add phrasings — core/graph.ts). */
export function firstLinePerId(lines: readonly GraphNode[]): GraphNode[] {
	const seen = new Map<string, GraphNode>();
	for (const line of lines) if (!seen.has(line.id)) seen.set(line.id, line);
	return [...seen.values()];
}

let shared: ReturnType<typeof createNodeTranslator> | null = null;

/** GET /api/graph/translations: the current Russian entries, and a background run if needed. */
export function nodeTranslationsView(): TranslationsView {
	shared ??= createNodeTranslator({ readNodes: () => firstLinePerId(stores.graphStore.readNodes()), translate: modelTranslateBatch });
	return shared.view();
}
