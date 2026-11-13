/**
 * Music-study fork: Gemini dictation, the Russian interface layer, and
 * Russian node names.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GeminiSttError, geminiModels, isSilent, parseWav, responseText, splitWav, transcribeWithGemini, wavFile, wavSeconds,
} from "../src/server/gemini-stt.ts";
import {
	createNodeTranslator, looksRussian, parseTranslationAnswer, pendingNodes, readTranslationFile, sourceHash, type TranslationInput,
} from "../src/server/graph-translations.ts";
import { translateText } from "../components/i18n/ru.ts";
import { translateWithSpacing } from "../components/i18n/translator.tsx";
import { localizeNodes, localizeReviewPayload } from "../components/node-translations.ts";
import { pcmFramesToWav } from "../components/dictation.tsx";
import { parseDictationHistory, isDictationEngine } from "../components/dictation-engine.tsx";
import { isNodeVisible } from "../components/graph-view.tsx";
import type { GraphNode } from "../src/core/contracts/graph.ts";

/** `seconds` of 16 kHz mono PCM; a sine when `loud`, else silence. */
function pcm(seconds: number, loud = true): Uint8Array {
	const samples = Math.round(16000 * seconds);
	const out = new Int16Array(samples);
	if (loud) for (let i = 0; i < samples; i++) out[i] = Math.round(Math.sin(i / 8) * 8000);
	return new Uint8Array(out.buffer);
}

describe("Gemini dictation: WAV handling", () => {
	it("builds and parses a 16 kHz mono WAV", () => {
		const wav = parseWav(wavFile(pcm(1)));
		assert.equal(wav.sampleRate, 16000);
		assert.equal(wav.channels, 1);
		assert.equal(wav.bitsPerSample, 16);
		assert.equal(wavSeconds(wav), 1);
	});

	it("the renderer's frame concatenation is the same WAV", () => {
		const a = new Int16Array([1, 2, 3]);
		const b = new Int16Array([4, 5]);
		const wav = parseWav(pcmFramesToWav([a, b]));
		assert.deepEqual([...new Int16Array(wav.data.slice().buffer)], [1, 2, 3, 4, 5]);
	});

	it("rejects files that are not PCM WAV", () => {
		assert.throws(() => parseWav(new TextEncoder().encode("not a wav file at all, just some text here....")), GeminiSttError);
	});

	it("splits long recordings into block-aligned WAV pieces", () => {
		const pieces = splitWav(parseWav(wavFile(pcm(10))), 4);
		assert.equal(pieces.length, 3);
		assert.deepEqual(pieces.map((p) => wavSeconds(parseWav(p))), [4, 4, 2]);
	});

	it("detects silence", () => {
		assert.equal(isSilent(parseWav(wavFile(pcm(1, false)))), true);
		assert.equal(isSilent(parseWav(wavFile(pcm(1)))), false);
	});

	it("reads only the answer text, never thought parts", () => {
		assert.equal(responseText({ candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: " Hallo Welt " }] } }] }), "Hallo Welt");
	});

	it("puts LH_GEMINI_STT_MODEL first", () => {
		assert.deepEqual(geminiModels({ LH_GEMINI_STT_MODEL: "gemini-x" })[0], "gemini-x");
		assert.equal(geminiModels({}).length >= 2, true);
	});
});

describe("Gemini dictation: transcription", () => {
	it("falls back to the next model on 404 and returns the transcript", async () => {
		const calls: { url: string; key: string | null; body: any }[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, key: new Headers(init.headers).get("x-goog-api-key"), body: JSON.parse(String(init.body)) });
			if (calls.length === 1) return Response.json({ error: { message: "model not found" } }, { status: 404 });
			return Response.json({ candidates: [{ content: { parts: [{ text: "Die Periode hat acht Takte." }] } }] });
		}) as unknown as typeof fetch;
		const result = await transcribeWithGemini(wavFile(pcm(1)), { key: "k-123", env: {}, fetchImpl, language: "de" });
		assert.equal(result.text, "Die Periode hat acht Takte.");
		assert.equal(calls.length, 2);
		const [firstCall, secondCall] = calls as [typeof calls[number], typeof calls[number]];
		assert.equal(firstCall.key, "k-123");
		assert.notEqual(firstCall.url, secondCall.url);
		const parts = secondCall.body.contents[0].parts;
		assert.match(parts[0].text, /Transcribe/);
		assert.match(parts[0].text, /"de"/);
		assert.equal(parts[1].inline_data.mime_type, "audio/wav");
		assert.equal(result.model, geminiModels({})[1]);
	});

	it("skips the API for silence and needs a key", async () => {
		let called = false;
		const fetchImpl = (async () => { called = true; return Response.json({}); }) as unknown as typeof fetch;
		const silent = await transcribeWithGemini(wavFile(pcm(1, false)), { key: "k", env: {}, fetchImpl });
		assert.equal(silent.text, "");
		assert.equal(called, false);
		await assert.rejects(transcribeWithGemini(wavFile(pcm(1)), { key: "", env: {}, fetchImpl }), (e: unknown) => e instanceof GeminiSttError && e.status === 503);
	});

	it("reports a rejected key plainly", async () => {
		const fetchImpl = (async () => Response.json({ error: { message: "API key not valid" } }, { status: 400 })) as unknown as typeof fetch;
		await assert.rejects(transcribeWithGemini(wavFile(pcm(1)), { key: "bad", env: {}, fetchImpl }), /Google key was rejected/);
	});
});

describe("dictation engine preference and history", () => {
	it("knows the Gemini engine", () => {
		assert.equal(isDictationEngine("gemini"), true);
		assert.equal(isDictationEngine("whisper"), false);
	});

	it("parses only well-formed history entries", () => {
		const raw = JSON.stringify([{ text: "a", at: 1, engine: "gemini" }, { text: 2 }, null, { text: "b", at: 2, engine: "deepgram" }]);
		assert.deepEqual(parseDictationHistory(raw).map((e) => e.text), ["a", "b"]);
		assert.deepEqual(parseDictationHistory("{bad"), []);
	});
});

describe("Russian interface strings", () => {
	it("translates exact UI strings and keeps surrounding spaces", () => {
		assert.equal(translateText("What do you want to learn?"), "Что вы хотите изучить?");
		assert.equal(translateWithSpacing(" Settings "), " Настройки ");
		assert.equal(translateWithSpacing("Recall cards ("), "Карточки (");
	});

	it("translates numbers and joined parts", () => {
		assert.equal(translateText("6m ago"), "6 мин назад");
		assert.equal(translateText("Waiting for input · 2d ago"), "Ждёт ответа · 2 дн. назад");
		assert.equal(translateText("3 nodes selected"), "выбрано узлов: 3");
	});

	it("leaves unknown text alone", () => {
		assert.equal(translateText("Fortspinnung type"), null);
		assert.equal(translateWithSpacing("Musik als Text"), null);
		assert.equal(translateWithSpacing("Немецкий"), null);
	});
});

function node(id: string, name: string, statement: string): GraphNode {
	return { id, name, statement, aliases: [], createdAt: "2026-11-01T00:00:00Z", provenance: [] };
}

describe("Russian node names", () => {
	it("detects text that is already Russian", () => {
		assert.equal(looksRussian("Период (Periode)"), true);
		assert.equal(looksRussian("Bar form (A-A-B)"), false);
	});

	it("parses a model answer and drops unknown ids", () => {
		const out = parseTranslationAnswer('Here:\n```json\n[{"id":"n1","name":"Период (Periode)","statement":"Период — ..."},{"id":"zz","name":"x","statement":"y"}]\n```', new Set(["n1"]));
		assert.deepEqual(out, [{ id: "n1", name: "Период (Periode)", statement: "Период — ..." }]);
	});

	it("translates missing nodes in batches, skips Russian ones, and redoes edited nodes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tr-"));
		const filePath = path.join(dir, "translations-ru.json");
		let nodes = [node("n1", "Bar form (A-A-B)", "A bar form repeats A before B."), node("n2", "Период", "Период из двух предложений.")];
		const seen: TranslationInput[][] = [];
		const translator = createNodeTranslator({
			readNodes: () => nodes,
			filePath,
			translate: async (batch) => { seen.push(batch); return batch.map((n) => ({ id: n.id, name: `RU ${n.name}`, statement: `RU ${n.statement}` })); },
		});
		const first = translator.view();
		assert.equal(first.pending, 2);
		await translator.idle();
		const done = translator.view();
		assert.equal(done.pending, 0);
		assert.deepEqual(done.translations.n1, { name: "RU Bar form (A-A-B)", statement: "RU A bar form repeats A before B." });
		assert.deepEqual(done.translations.n2, { name: "Период", statement: "Период из двух предложений." });
		assert.deepEqual(seen.map((batch) => batch.map((n) => n.id)), [["n1"]]);

		nodes = [node("n1", "Bar form", "A bar form repeats A before B.")];
		assert.equal(pendingNodes(nodes, readTranslationFile(filePath)).length, 1);
		translator.view();
		await translator.idle();
		const file = readTranslationFile(filePath);
		assert.equal(file.nodes.n1?.src, sourceHash(nodes[0]!));
		assert.equal(file.nodes.n2, undefined, "deleted nodes leave the file");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("pauses after a failure instead of retrying at once", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tr-"));
		let calls = 0;
		const translator = createNodeTranslator({
			readNodes: () => [node("n1", "Satz", "A sentence form.")],
			filePath: path.join(dir, "t.json"),
			translate: async () => { calls++; throw new Error("no model"); },
		});
		translator.view();
		await translator.idle();
		const after = translator.view();
		await translator.idle();
		assert.equal(calls, 1);
		assert.equal(after.error, "no model");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("swaps names in place, keeps originals searchable, and is idempotent", () => {
		const first = node("n1", "Bar form (A-A-B)", "A bar form repeats A before B.");
		const nodes = [first];
		const originals = new Map();
		const t = { n1: { name: "Барная форма (Bar form)", statement: "Барная форма повторяет A перед B." } };
		const renamed = localizeNodes([nodes], t, originals);
		assert.deepEqual([...renamed], [["n1", "Барная форма (Bar form)"]]);
		assert.equal(first.name, "Барная форма (Bar form)");
		assert.equal(originals.get("n1").name, "Bar form (A-A-B)");
		assert.equal(localizeNodes([nodes], t, originals).size, 0);
		assert.equal(first.aliases.length, 2);
		assert.equal(isNodeVisible(first, "bar form (a-a-b)"), true);
		assert.equal(isNodeVisible(first, "барная"), true);
		assert.equal(isNodeVisible(first, "periode"), false);
	});

	it("localizes review items", () => {
		const item = { id: "n1", name: "Satz", statement: "A sentence." };
		const payload = localizeReviewPayload({ due: [item], upcoming: [], fresh: [item] }, { n1: { name: "Предложение (Satz)", statement: "" } });
		assert.equal(payload?.due[0]?.name, "Предложение (Satz)");
		assert.equal(payload?.due[0]?.statement, "A sentence.");
		assert.equal(payload?.fresh?.[0]?.name, "Предложение (Satz)");
	});
});
