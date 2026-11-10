import assert from "node:assert/strict";
import { test } from "node:test";
import { handyCandidates, resolveHandyBinary } from "../src/server/handy.ts";
import { piModels } from "../src/agent/models.ts";
import { MUSIC_THEORY_NOTES, NOTES_EXTRACTOR_INSTRUCTIONS } from "../src/agent/subagents/extraction.ts";
import { ClaudeCodeError } from "../src/agent/claude-code/constants.ts";
import { describeNode, searchNodes } from "../cli/learnharness.mjs";

test("Handy lookup: LH_HANDY_PATH wins, then the platform install locations", () => {
	const win = handyCandidates({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", LH_HANDY_PATH: "D:\\Tools\\handy.exe" }, platform: "win32", homeDir: "C:\\Users\\a" });
	assert.equal(win[0], "D:\\Tools\\handy.exe");
	assert.ok(win.includes("C:\\Users\\a\\AppData\\Local\\Handy\\handy.exe"));
	const mac = handyCandidates({ env: {}, platform: "darwin", homeDir: "/Users/a" });
	assert.equal(mac[0], "/Applications/Handy.app/Contents/MacOS/Handy");
	const found = resolveHandyBinary({ env: { PATH: "/opt/x:/usr/bin" }, platform: "linux", homeDir: "/home/a", exists: (p) => p === "/usr/bin/handy" });
	assert.equal(found, "/usr/bin/handy");
	assert.equal(resolveHandyBinary({ env: {}, platform: "linux", homeDir: "/home/a", exists: () => false }), null);
});

test("Claude Fable 5.2 is in the Anthropic API catalog and the Claude Code catalog", () => {
	const models = piModels();
	const api = models.getModel("anthropic", "claude-fable-5-2");
	assert.equal(api?.name, "Claude Fable 5.2");
	assert.equal(api?.cost.input, 8);
	assert.equal(api?.contextWindow, 1_000_000);
	assert.equal(models.getModel("claude-code", "claude-fable-5-2")?.name, "Claude Fable 5.2");
});

test("the notes extractor carries the music theory section; the sign-in error says what to do", () => {
	assert.ok(NOTES_EXTRACTOR_INSTRUCTIONS.endsWith(MUSIC_THEORY_NOTES));
	assert.match(ClaudeCodeError.NotSignedIn, /\/login/);
});

test("CLI graph search ranks name matches first and ignores accents", () => {
	const graph = {
		propositions: [
			{ id: "n_1", name: "Trugschluss", statement: "D–Tp statt D–T.", aliases: [], provenance: [{ chatId: "src_a" }] },
			{ id: "n_2", name: "Kadenz", statement: "Ein Trugschluss ersetzt die Tonika.", aliases: [], provenance: [] },
			{ id: "n_3", name: "Periode", statement: "Vordersatz und Nachsatz.", aliases: [], provenance: [] },
		],
		chains: [{ premises: ["n_2"], conclusion: "n_1" }],
		sessions: {},
		fileSources: { src_a: "Formenlehre.pdf" },
	};
	assert.deepEqual(searchNodes(graph, "trugschluss").map((n: { id: string }) => n.id), ["n_1", "n_2"]);
	assert.deepEqual(searchNodes(graph, "Ubersicht"), []);
	const info = describeNode(graph, "n_1")!;
	assert.deepEqual(info.derivedBy, ["Kadenz ⇒ Trugschluss"]);
	assert.deepEqual(info.sources, ["Formenlehre.pdf"]);
});
