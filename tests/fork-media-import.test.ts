import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, it } from "node:test";
import { POST } from "../app/api/graph/import/route.ts";
import { extraction } from "../src/server/index.ts";
import { stores } from "../src/server/stores.ts";
import { detectAudio, detectImage, transcribeAudio } from "../src/server/media-import.ts";

const original = extraction.importNotes;
after(() => { extraction.importNotes = original; });

function post(files: { name: string; text: string }[]) {
	const form = new FormData();
	for (const { name, text } of files) form.append("files", new File([text], name));
	return POST(new Request("http://localhost/api/graph/import", { method: "POST", body: form }));
}

it("an unchanged, completed file is skipped on re-import; a changed one runs again", async () => {
	const name = `fork-skip-${randomUUID()}.md`;
	const id = `src_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
	let calls = 0;
	extraction.importNotes = async ({ filePath }) => {
		calls++;
		stores.graphStore.upsertSource({ id, filePath, importedAt: new Date().toISOString() });
		return { nodes: 1, chains: 0 };
	};
	try {
		const first = (await (await post([{ name, text: "Periode = Vordersatz + Nachsatz" }])).json()).results[0];
		assert.equal(first.ok, true);
		const second = (await (await post([{ name, text: "Periode = Vordersatz + Nachsatz" }])).json()).results[0];
		assert.equal(second.ok, true);
		assert.equal(second.notice, "Already in the graph; skipped.");
		assert.equal(calls, 1);
		await post([{ name, text: "Periode = Vordersatz + Nachsatz (8 Takte)" }]);
		assert.equal(calls, 2, "changed content imports again");
		stores.graphStore.deleteSources(new Set([id]));
		await post([{ name, text: "Periode = Vordersatz + Nachsatz (8 Takte)" }]);
		assert.equal(calls, 3, "a source deleted from the graph imports again");
	} finally {
		stores.graphStore.deleteSources(new Set([id]));
	}
});

it("detects images and audio by their bytes", () => {
	assert.equal(detectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), "image/png");
	assert.equal(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(detectImage(new TextEncoder().encode("# Notes")), null);
	assert.equal(detectAudio(new TextEncoder().encode("ID3\u0004rest"), "a.mp3"), "audio/mpeg");
	assert.equal(detectAudio(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "), "a.wav"), "audio/wav");
	assert.equal(detectAudio(new TextEncoder().encode("plain words"), "a.bin"), null);
});

it("audio transcription uses Deepgram's pre-recorded API with the stored key", async () => {
	const previous = process.env.DEEPGRAM_API_KEY;
	process.env.DEEPGRAM_API_KEY = "test-key";
	try {
		let seen: { url: string; auth: string | null } | null = null;
		const text = await transcribeAudio(new Uint8Array([1, 2, 3]), "audio/mpeg", (async (url: string, init: RequestInit) => {
			seen = { url, auth: new Headers(init.headers).get("authorization") };
			return Response.json({ results: { channels: [{ alternatives: [{ transcript: "raw", paragraphs: { transcript: "Der Trugschluss führt zur Tp." } }] }] } });
		}) as unknown as typeof fetch);
		assert.equal(text, "Der Trugschluss führt zur Tp.");
		assert.match(seen!.url, /api\.deepgram\.com\/v1\/listen\?model=nova-3/);
		assert.equal(seen!.auth, "Token test-key");
	} finally {
		if (previous === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = previous;
	}
});
