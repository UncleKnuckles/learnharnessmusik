#!/usr/bin/env node
/**
 * learnharness — command line and MCP bridge to a running LearnHarness.
 *
 * Everything goes through the running app's local HTTP API, so the CLI sees
 * the same graph, settings and model slots as the window, and imports show
 * up live in the app. The desktop app writes its address and per-launch
 * secret to <userData>/local-api.json while it runs (see electron/main.cjs);
 * `next dev` needs neither (LH_URL defaults to http://localhost:3000).
 *
 *   learnharness status                 app, graph and Claude Code status
 *   learnharness models [--all]         model catalog (Claude Code + API keys), Fable marked
 *   learnharness graph [--json]         graph summary, or the full snapshot as JSON
 *   learnharness search <words…>        find graph ideas by name/statement
 *   learnharness node <id>              one idea with its chains and sources
 *   learnharness sessions               teaching / practice sessions
 *   learnharness import <file|dir…>     extract .md/.txt/.pdf, images and audio into the graph
 *   learnharness ask [--model M] [--effort E] <question…>
 *                                       ask Claude (default: Fable 5.2) with your graph as context
 *   learnharness review [--all]         ideas due for spaced repetition (FSRS-6), plus today's new cards
 *   learnharness grade <id> <1-4>       record a flashcard grade: 1 Again, 2 Hard, 3 Good, 4 Easy
 *   learnharness doctor                 check the Claude Code sign-in LearnHarness relies on
 *   learnharness mcp                    run as an MCP server over stdio
 *
 * Environment: LH_URL, LH_SECRET (override discovery), LH_CLAUDE_PATH
 * (claude binary for `ask`/`doctor`), LH_DATA_HOME (userData directory).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FABLE = "claude-fable-5-2";
const IMPORT_EXT = /\.(?:md|markdown|txt|rst|org|adoc|tex|pdf|png|jpe?g|webp|mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i;
const MAX_REQUEST_BYTES = 2047 * 1024 * 1024; // server cap: 2 GiB per request

// ─── connection ──────────────────────────────────────────────────────────

function userDataDirs() {
	if (process.env.LH_DATA_HOME) return [process.env.LH_DATA_HOME];
	const home = os.homedir();
	const base = process.platform === "win32" ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
		: process.platform === "darwin" ? path.join(home, "Library", "Application Support")
		: (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
	return [path.join(base, "LearnHarness"), path.join(base, "LearnHarness-dev")];
}

export function discoverConnection() {
	if (process.env.LH_URL) return { url: process.env.LH_URL.replace(/\/$/, ""), secret: process.env.LH_SECRET ?? null, source: "LH_URL" };
	for (const dir of userDataDirs()) {
		const file = path.join(dir, "local-api.json");
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof raw.url === "string") return { url: raw.url.replace(/\/$/, ""), secret: typeof raw.secret === "string" ? raw.secret : null, source: file };
		} catch {}
	}
	return { url: "http://localhost:3000", secret: null, source: "default (next dev)" };
}

class AppUnavailableError extends Error {}

export async function api(pathname, init = {}) {
	const { url, secret, source } = discoverConnection();
	const headers = new Headers(init.headers ?? {});
	if (secret) headers.set("x-learnharness-desktop", secret);
	let res;
	try {
		res = await fetch(url + pathname, { ...init, headers });
	} catch {
		throw new AppUnavailableError(`LearnHarness is not reachable at ${url} (from ${source}). Start the app first.`);
	}
	const text = await res.text();
	let body;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	if (!res.ok) {
		const message = body && typeof body === "object" && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
		throw new Error(`${pathname}: ${message}`);
	}
	return body;
}

// ─── graph helpers ───────────────────────────────────────────────────────

const normalize = (text) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

export function searchNodes(graph, query, limit = 20) {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const scored = [];
	for (const node of graph.propositions ?? graph.nodes ?? []) {
		const name = normalize(node.name ?? "");
		const haystack = `${name} ${normalize(node.statement ?? "")} ${normalize((node.aliases ?? []).join(" "))}`;
		let score = 0;
		for (const word of words) {
			if (name.includes(word)) score += 3;
			else if (haystack.includes(word)) score += 1;
		}
		if (score > 0) scored.push({ node, score });
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.node);
}

function sourcesOf(graph, nodeId) {
	const node = (graph.propositions ?? []).find((n) => n.id === nodeId);
	const ids = new Set((node?.provenance ?? []).map((p) => p.chatId));
	return [...ids].map((id) => graph.sessions?.[id] ?? graph.fileSources?.[id] ?? id);
}

export function describeNode(graph, nodeId) {
	const byId = new Map((graph.propositions ?? []).map((n) => [n.id, n]));
	const node = byId.get(nodeId);
	if (!node) return null;
	const label = (id) => byId.get(id)?.name ?? id;
	const derivedBy = (graph.chains ?? []).filter((c) => c.conclusion === nodeId)
		.map((c) => `${c.premises.map(label).join(" + ")} ⇒ ${node.name}`);
	const supports = (graph.chains ?? []).filter((c) => c.premises.includes(nodeId))
		.map((c) => `${c.premises.map(label).join(" + ")} ⇒ ${label(c.conclusion)}`);
	return { id: node.id, name: node.name, statement: node.statement, aliases: node.aliases ?? [], derivedBy, supports, sources: sourcesOf(graph, nodeId) };
}

export function graphSummary(graph) {
	const props = graph.propositions ?? [];
	return {
		ideas: props.length,
		chains: (graph.chains ?? []).length,
		sessions: Object.keys(graph.sessions ?? {}).length,
		importedFiles: Object.values(graph.fileSources ?? {}),
	};
}

// ─── models ──────────────────────────────────────────────────────────────

export async function listModels({ all = false } = {}) {
	const catalog = await api("/api/models");
	const configured = new Set((catalog.providers ?? []).filter((p) => p.keyPresent).map((p) => p.id));
	const models = (catalog.models ?? []).filter((m) => all || m.provider === "claude-code" || configured.has(m.provider) || /fable/i.test(m.id));
	return { models, slots: catalog.slots ?? null, rolePins: catalog.rolePins ?? null };
}

// ─── import ──────────────────────────────────────────────────────────────

function collectFiles(inputs) {
	const out = [];
	for (const input of inputs) {
		const abs = path.resolve(input);
		const stat = fs.statSync(abs);
		if (stat.isFile()) {
			if (IMPORT_EXT.test(abs)) out.push({ abs, rel: path.basename(abs) });
			continue;
		}
		const root = path.basename(abs);
		const walk = (dir) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".")) continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (IMPORT_EXT.test(entry.name)) out.push({ abs: full, rel: [root, ...path.relative(abs, full).split(path.sep)].join("/") });
			}
		};
		walk(abs);
	}
	return out;
}

/** One request per batch under the server's 2 GiB body cap. */
export async function importFiles(inputs, onResult = () => {}) {
	const files = collectFiles(inputs);
	if (files.length === 0) throw new Error("No supported files found (.md, .txt, .pdf, images, audio).");
	const batches = [];
	let current = [];
	let bytes = 0;
	for (const file of files) {
		const size = fs.statSync(file.abs).size;
		if (size > MAX_REQUEST_BYTES) { onResult({ filePath: file.rel, ok: false, error: "Too big. Max 2 GB." }); continue; }
		if (current.length > 0 && bytes + size > MAX_REQUEST_BYTES) { batches.push(current); current = []; bytes = 0; }
		current.push(file);
		bytes += size;
	}
	if (current.length > 0) batches.push(current);
	const results = [];
	for (const batch of batches) {
		const form = new FormData();
		for (const file of batch) {
			// Path segments may not carry ":" or "\" (server contract).
			const rel = file.rel.replace(/[\\:]/g, "_");
			const name = rel.split("/").at(-1);
			form.append("files", new Blob([fs.readFileSync(file.abs)]), name);
			form.append("paths", rel);
		}
		const body = await api("/api/graph/import", { method: "POST", body: form });
		for (const result of body.results ?? []) { results.push(result); onResult(result); }
	}
	return results;
}

// ─── claude CLI (ask / doctor) ───────────────────────────────────────────

function findClaude() {
	if (process.env.LH_CLAUDE_PATH) return process.env.LH_CLAUDE_PATH;
	const win = process.platform === "win32";
	const name = win ? "claude.exe" : "claude";
	const home = os.homedir();
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
		path.join(home, ".local", "bin"),
		path.join(home, ".claude", "local"),
		...(win ? [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")] : ["/opt/homebrew/bin", "/usr/local/bin"]),
	];
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
	}
	return null;
}

function runClaude(args, { input, onStdout } = {}) {
	const binary = findClaude();
	if (!binary) return Promise.reject(new Error("claude CLI not found. Install Claude Code, or set LH_CLAUDE_PATH."));
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; onStdout?.(chunk.toString()); });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input ?? "");
	});
}

const TUTOR_PROMPT = `You are a music theory tutor inside LearnHarness. The learner studies at a German-speaking conservatory (Formenlehre, Funktionstheorie, Tonsatz, cadences, repertoire). Answer in the language of the question. Use the course's German technical terms and give the Russian or English equivalent where it helps. Ground answers in the learner's knowledge graph below when it is relevant, and say clearly when something is not in the graph.`;

export async function askClaude(question, { model = FABLE, effort = "high", stream } = {}) {
	let context = "";
	try {
		const graph = await api("/api/graph");
		const hits = searchNodes(graph, question, 25);
		if (hits.length > 0) {
			context = "\n\nTHE LEARNER'S KNOWLEDGE GRAPH (most relevant ideas):\n" +
				hits.map((n) => `- ${n.name}: ${n.statement.replace(/\s+/g, " ")}`).join("\n");
		}
	} catch (error) {
		if (!(error instanceof AppUnavailableError)) throw error;
		context = "\n\n(The LearnHarness app is not running, so the knowledge graph is unavailable.)";
	}
	const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lh-ask-")), "system.md");
	fs.writeFileSync(promptFile, TUTOR_PROMPT + context, { mode: 0o600 });
	try {
		const result = await runClaude(["-p", "--model", model, "--effort", effort, "--system-prompt-file", promptFile, "--tools", ""], { input: question, onStdout: stream });
		if (result.code !== 0) throw new Error(signedOutHint(result.stdout + result.stderr) ?? (result.stderr.trim() || result.stdout.trim() || `claude exited with ${result.code}`));
		return result.stdout.trim();
	} finally {
		fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
	}
}

function signedOutHint(output) {
	return /not logged in|please run \/login|authentication_failed/i.test(output)
		? "Claude Code is not signed in. Run `claude`, then /login, and try again."
		: null;
}

export async function doctor() {
	const binary = findClaude();
	const lines = [`claude binary: ${binary ?? "NOT FOUND (install Claude Code or set LH_CLAUDE_PATH)"}`];
	if (binary) {
		const version = await runClaude(["--version"]);
		lines.push(`claude version: ${version.stdout.trim() || version.stderr.trim()}`);
		const ping = await runClaude(["-p", "--model", "haiku", "--output-format", "json", "--tools", ""], { input: "Reply with OK." });
		const hint = signedOutHint(ping.stdout + ping.stderr);
		lines.push(hint ? `sign-in: ${hint}` : ping.code === 0 ? "sign-in: OK (a test request succeeded)" : `sign-in: request failed: ${(ping.stderr || ping.stdout).trim().slice(0, 300)}`);
	}
	const conn = discoverConnection();
	try {
		await api("/api/graph/status");
		lines.push(`LearnHarness app: reachable at ${conn.url}`);
	} catch (error) {
		lines.push(`LearnHarness app: ${error.message}`);
	}
	return lines.join("\n");
}

// ─── spaced repetition ───────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const GRADE_NAMES = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

/** "overdue 3d" / "due today" / "in 5d", like the Review page. */
export function formatDue(dueAt, now) {
	const diff = dueAt - now;
	if (diff <= 0) {
		const days = Math.floor(-diff / DAY_MS);
		return days === 0 ? "due today" : `overdue ${days}d`;
	}
	return `in ${Math.ceil(diff / DAY_MS)}d`;
}

export function reviewSummary(payload, { all = false } = {}) {
	const pick = (item) => ({ id: item.id, name: item.name, statement: item.statement, due: formatDue(item.dueAt, payload.now), ...(item.verifying ? { recheck: true } : {}) });
	return {
		due: (payload.due ?? []).map(pick),
		newCards: (payload.fresh ?? []).map(({ id, name, statement }) => ({ id, name, statement })),
		...(all ? { upcoming: (payload.upcoming ?? []).map(pick) } : { upcomingCount: (payload.upcoming ?? []).length }),
	};
}

async function gradeCard(id, grade, session) {
	const value = Number(grade);
	if (![1, 2, 3, 4].includes(value)) throw new Error("Grade must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy).");
	await api("/api/review/cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeId: id, grade: value, ...(session ? { session } : {}) }) });
	return `Recorded ${GRADE_NAMES[value]} for ${id}.`;
}

// ─── MCP server ──────────────────────────────────────────────────────────

async function runMcp() {
	const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
		import("@modelcontextprotocol/sdk/server/mcp.js"),
		import("@modelcontextprotocol/sdk/server/stdio.js"),
		import("zod"),
	]);
	const server = new McpServer({ name: "learnharness", version: "0.8.2" });
	const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
	const guard = (fn) => async (args) => {
		try { return text(await fn(args ?? {})); }
		catch (error) { return { ...text(error instanceof Error ? error.message : String(error)), isError: true }; }
	};

	server.registerTool("graph_overview", {
		title: "Knowledge graph overview",
		description: "Counts of ideas, chains and sessions in the LearnHarness knowledge graph, and the imported files.",
		inputSchema: {},
	}, guard(async () => graphSummary(await api("/api/graph"))));

	server.registerTool("search_ideas", {
		title: "Search the knowledge graph",
		description: "Find ideas (propositions) in the learner's knowledge graph whose name, statement or aliases match the query words. Works with German music theory terms.",
		inputSchema: { query: z.string().describe("Words to look for, e.g. 'Trugschluss' or 'Periode Nachsatz'"), limit: z.number().int().min(1).max(100).optional() },
	}, guard(async ({ query, limit }) => searchNodes(await api("/api/graph"), query, limit ?? 20).map((n) => ({ id: n.id, name: n.name, statement: n.statement }))));

	server.registerTool("get_idea", {
		title: "Get one idea",
		description: "One idea from the knowledge graph with the chains that derive it, the chains it supports, and its sources.",
		inputSchema: { id: z.string().describe("Idea id, e.g. n_abc123") },
	}, guard(async ({ id }) => describeNode(await api("/api/graph"), id) ?? `No idea with id ${id}`));

	server.registerTool("list_sessions", {
		title: "List sessions",
		description: "Teaching and practice sessions in LearnHarness.",
		inputSchema: {},
	}, guard(async () => ((await api("/api/chats")).chats ?? []).map((c) => ({ id: c.id, title: c.title, kind: c.kind ?? "teaching", updatedAt: c.updatedAt }))));

	server.registerTool("import_files", {
		title: "Import files into the graph",
		description: "Extract local .md, .txt, .pdf, image (PNG/JPEG/WebP) or audio files, or folders of them, into the knowledge graph. Unchanged files that were already imported are skipped. Paths are on the machine running LearnHarness.",
		inputSchema: { paths: z.array(z.string()).min(1) },
	}, guard(async ({ paths }) => importFiles(paths)));

	server.registerTool("review_due", {
		title: "Ideas due for review",
		description: "Spaced repetition (FSRS-6): the learner's ideas whose recall is due now, and today's new flashcards. Use it to remind the learner what to review or to quiz them: show an idea's name, let them recall it, then grade with grade_card.",
		inputSchema: { all: z.boolean().optional().describe("Also list upcoming (not yet due) ideas") },
	}, guard(async ({ all }) => reviewSummary(await api("/api/review"), { all })));

	const mcpSitting = `cards-mcp-${Date.now()}`;
	server.registerTool("grade_card", {
		title: "Grade a flashcard",
		description: "Record how well the learner recalled one idea, which reschedules it: 1 Again (forgot), 2 Hard, 3 Good, 4 Easy. Grade honestly from the learner's own answer.",
		inputSchema: { id: z.string().describe("Idea id from review_due"), grade: z.number().int().min(1).max(4) },
	}, guard(async ({ id, grade }) => gradeCard(id, grade, mcpSitting)));

	server.registerTool("list_models", {
		title: "List models",
		description: "Models LearnHarness can use (Claude Code CLI models incl. Claude Fable 5.2, and API-key providers), plus the configured model slots.",
		inputSchema: { all: z.boolean().optional() },
	}, guard(async ({ all }) => listModels({ all })));

	server.registerTool("ask_tutor", {
		title: "Ask the music theory tutor",
		description: "Ask Claude (default Claude Fable 5.2 via the local Claude Code sign-in) a question, grounded in the learner's knowledge graph.",
		inputSchema: { question: z.string(), model: z.string().optional().describe("Claude Code model id or alias; default claude-fable-5-2") },
	}, guard(async ({ question, model }) => askClaude(question, { model: model ?? FABLE })));

	await server.connect(new StdioServerTransport());
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function takeFlag(args, name, fallback) {
	const index = args.indexOf(name);
	if (index === -1) return fallback;
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}

const USAGE = `  learnharness status                 app, graph and Claude Code status
  learnharness models [--all]         model catalog, Claude Fable marked with ★
  learnharness graph [--json]         graph summary (or the full snapshot as JSON)
  learnharness search <words…>        find graph ideas by name or statement
  learnharness node <id>              one idea with its chains and sources
  learnharness sessions               teaching and practice sessions
  learnharness import <file|dir…>     extract .md/.txt/.pdf, images and audio into the graph
  learnharness ask [--model M] [--effort E] <question…>
                                      ask Claude (default Fable 5.2) with your graph as context
  learnharness review [--all]         ideas due for spaced repetition, plus today's new cards
  learnharness grade <id> <1-4>       record a flashcard grade: 1 Again, 2 Hard, 3 Good, 4 Easy
  learnharness doctor                 check the Claude Code sign-in LearnHarness needs
  learnharness mcp                    run as an MCP server over stdio

Most commands accept --json.`;

async function main(argv) {
	const [command, ...args] = argv;
	const json = args.includes("--json");
	const rest = args.filter((a) => a !== "--json");
	switch (command) {
		case "status": {
			const conn = discoverConnection();
			const [graph, claude] = await Promise.all([api("/api/graph"), api("/api/claude-code", { headers: { "x-learnharness-claude-code": "1" } }).catch(() => null)]);
			const summary = graphSummary(graph);
			if (json) return console.log(JSON.stringify({ url: conn.url, graph: summary, claudeCode: claude }, null, 2));
			console.log(`LearnHarness: ${conn.url}`);
			console.log(`Graph: ${summary.ideas} ideas, ${summary.chains} chains, ${summary.sessions} sessions, ${summary.importedFiles.length} imported files`);
			if (claude) console.log(`Claude Code: ${claude.state ?? JSON.stringify(claude)}${claude.version ? ` (${claude.version})` : ""}`);
			return;
		}
		case "models": {
			const { models, slots } = await listModels({ all: rest.includes("--all") });
			if (json) return console.log(JSON.stringify({ models, slots }, null, 2));
			for (const m of models) console.log(`${/fable/i.test(m.id) ? "★" : " "} ${m.provider}/${m.id}  ${m.name}`);
			if (slots) console.log(`\nSlots: ${Object.entries(slots).map(([k, v]) => `${k}=${v ? `${v.provider}/${v.id}` : "—"}`).join("  ")}`);
			console.log(`\n★ Claude Fable 5.2: pick claude-code/${FABLE} (Claude Code sign-in) or anthropic/${FABLE} (API key) in Settings → Models.`);
			return;
		}
		case "graph": {
			const graph = await api("/api/graph");
			if (json) return console.log(JSON.stringify(graph, null, 2));
			const s = graphSummary(graph);
			console.log(`${s.ideas} ideas, ${s.chains} chains, ${s.sessions} sessions`);
			for (const file of s.importedFiles) console.log(`  file: ${file}`);
			return;
		}
		case "search": {
			const hits = searchNodes(await api("/api/graph"), rest.join(" "));
			if (json) return console.log(JSON.stringify(hits, null, 2));
			if (hits.length === 0) return console.log("No matching ideas.");
			for (const n of hits) console.log(`${n.id}  ${n.name}\n    ${n.statement.replace(/\s+/g, " ")}`);
			return;
		}
		case "node": {
			const info = describeNode(await api("/api/graph"), rest[0] ?? "");
			if (!info) throw new Error(`No idea with id ${rest[0]}`);
			if (json) return console.log(JSON.stringify(info, null, 2));
			console.log(`${info.name}\n${info.statement}`);
			if (info.derivedBy.length) console.log(`\nDerived by:\n  ${info.derivedBy.join("\n  ")}`);
			if (info.supports.length) console.log(`\nSupports:\n  ${info.supports.join("\n  ")}`);
			if (info.sources.length) console.log(`\nSources: ${info.sources.join(", ")}`);
			return;
		}
		case "sessions": {
			const chats = (await api("/api/chats")).chats ?? [];
			if (json) return console.log(JSON.stringify(chats, null, 2));
			for (const c of chats) console.log(`${c.id}  [${c.kind ?? "teaching"}]  ${c.title}`);
			return;
		}
		case "import": {
			if (rest.length === 0) throw new Error("Usage: learnharness import <file|dir…>");
			console.log("Extracting… (this runs the model; large PDFs take a while)");
			const results = await importFiles(rest, (r) => {
				console.log(r.ok ? `✓ ${r.filePath}: ${r.stats?.nodes ?? 0} ideas, ${r.stats?.chains ?? 0} chains${r.notice ? ` (${r.notice})` : ""}`
					: `✗ ${r.filePath}: ${r.error}`);
			});
			if (results.some((r) => !r.ok)) process.exitCode = 1;
			return;
		}
		case "ask": {
			const model = takeFlag(rest, "--model", FABLE);
			const effort = takeFlag(rest, "--effort", "high");
			const question = rest.join(" ").trim();
			if (!question) throw new Error("Usage: learnharness ask [--model M] [--effort E] <question>");
			process.stderr.write(`[${model}]\n`);
			await askClaude(question, { model, effort, stream: (chunk) => process.stdout.write(chunk) });
			process.stdout.write("\n");
			return;
		}
		case "review": {
			const summary = reviewSummary(await api("/api/review"), { all: rest.includes("--all") });
			if (json) return console.log(JSON.stringify(summary, null, 2));
			console.log(summary.due.length ? `Due now (${summary.due.length}):` : "Nothing is due.");
			for (const item of summary.due) console.log(`  ${item.id}  ${item.name}  [${item.due}${item.recheck ? ", re-check" : ""}]`);
			if (summary.newCards.length) {
				console.log(`\nNew cards today (${summary.newCards.length}):`);
				for (const item of summary.newCards) console.log(`  ${item.id}  ${item.name}`);
			}
			if (summary.upcoming) for (const item of summary.upcoming) console.log(`  later: ${item.id}  ${item.name}  [${item.due}]`);
			else if (summary.upcomingCount) console.log(`\n${summary.upcomingCount} more come up later (--all lists them).`);
			return;
		}
		case "grade": {
			if (rest.length < 2) throw new Error("Usage: learnharness grade <id> <1-4>");
			return console.log(await gradeCard(rest[0], rest[1]));
		}
		case "doctor":
			return console.log(await doctor());
		case "mcp":
			return runMcp();
		case undefined:
		case "help":
		case "--help":
		case "-h":
			return console.log(`learnharness — CLI and MCP bridge for LearnHarness\n\n${USAGE}`);
		default:
			throw new Error(`Unknown command "${command}". Run: learnharness help`);
	}
}

const invokedDirectly = (() => {
	try { return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url)); }
	catch { return false; }
})();
if (invokedDirectly) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
