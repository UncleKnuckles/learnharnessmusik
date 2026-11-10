/**
 * Music-study fork: more import formats and no repeated work.
 *
 *  - Images (PNG, JPEG, WebP): the vision slot's model transcribes the page
 *    — text, music examples, function analyses, tables, diagrams — into
 *    Markdown, which then runs through the ordinary notes extraction.
 *  - Audio (MP3, WAV, M4A, OGG, FLAC, WebM …): Deepgram's pre-recorded API
 *    transcribes the file with the Deepgram key from Settings → Keys
 *    (Handy only does live dictation, it does not accept files).
 *  - Completed imports are fingerprinted by path + content hash, so
 *    re-importing a whole folder skips the files already in the graph and
 *    only processes new, changed or previously failed ones.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";

import { PATHS } from "../../config.ts";
import { processImage } from "../agent/image-processing/index.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { engineForRole } from "./chat-handler.ts";
import { keyValue, providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

// ─── format detection ────────────────────────────────────────────────────

export type MediaKind = "image" | "audio";

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));

export function detectImage(bytes: Uint8Array): string | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
	return null;
}

const AUDIO_BY_EXTENSION: Record<string, string> = {
	mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg",
	oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", webm: "audio/webm", mp4: "audio/mp4",
};

export function detectAudio(bytes: Uint8Array, filename: string): string | null {
	if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
	if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
	if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
	if (ascii(bytes, 4, 8) === "ftyp") return "audio/mp4";
	if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
	const ext = filename.split(".").at(-1)?.toLowerCase() ?? "";
	return AUDIO_BY_EXTENSION[ext] ?? null;
}

// ─── image → Markdown ────────────────────────────────────────────────────

const IMAGE_PROMPT = `Transcribe this page for a music theory student's notes. Write Markdown in the page's own
language (usually German). Keep every heading, definition, rule and list item. For music examples,
write what they show in text: key, meter, the voices or chord sequence, function symbols (T, S, D, Tp,
D7, DD …), figured-bass numbers, scale degrees and bar numbers exactly as printed. Describe diagrams and
tables as Markdown tables or lists. Do not add explanations of your own; transcribe only. If a part is
unreadable, write [unreadable].`;

export class MediaImportError extends Error {}

export async function transcribeImage(bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<{ text: string; model: string }> {
	const engine = engineForRole("pdfReader");
	if (!engine) throw new MediaImportError("Images need a vision model. Set the Vision slot in Settings → Models.");
	if (!providerKeyPresent(engine.model.provider)) throw new MediaImportError(`Images need the ${engine.model.provider} key or sign-in for the Vision model.`);
	if (!engine.model.input.includes("image")) throw new MediaImportError(`${engine.model.name} cannot read images. Pick a vision model in Settings → Models.`);
	const image = await processImage(bytes, mimeType, { resizeOptions: engine.model.inputLimits?.images?.resize });
	if (!image.ok) throw new MediaImportError(image.message);
	const messages: Message[] = [{
		role: "user",
		content: [{ type: "image", data: image.data, mimeType: image.mimeType }, { type: "text", text: IMAGE_PROMPT }],
		timestamp: Date.now(),
	}];
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt: "You transcribe study material accurately.", messages }), { signal } as never);
	for await (const event of stream) {
		if (event.type === "done") {
			const text = event.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
			if (!text) throw new MediaImportError("The vision model returned no text for this image.");
			return { text, model: engine.model.name };
		}
		if (event.type === "error") throw new MediaImportError(event.error.errorMessage ?? "The vision model failed.");
	}
	throw new MediaImportError("The vision model stream ended without a result.");
}

// ─── audio → transcript ──────────────────────────────────────────────────

export async function transcribeAudio(bytes: Uint8Array, mimeType: string, request: typeof fetch = fetch): Promise<string> {
	const key = keyValue("DEEPGRAM_API_KEY");
	if (!key) throw new MediaImportError("Audio files need a Deepgram key (Settings → Keys → Dictation). Handy only does live dictation.");
	const params = new URLSearchParams({ model: "nova-3", smart_format: "true", paragraphs: "true", detect_language: "true" });
	const res = await request(`https://api.deepgram.com/v1/listen?${params}`, {
		method: "POST",
		headers: { Authorization: `Token ${key}`, "Content-Type": mimeType },
		body: bytes as unknown as BodyInit,
	});
	if (!res.ok) throw new MediaImportError(`Deepgram transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
	const data = await res.json() as { results?: { channels?: { alternatives?: { transcript?: string; paragraphs?: { transcript?: string } }[] }[] } };
	const alt = data.results?.channels?.[0]?.alternatives?.[0];
	const text = (alt?.paragraphs?.transcript ?? alt?.transcript ?? "").trim();
	if (!text) throw new MediaImportError("No speech found in this audio file.");
	return text;
}

// ─── completed-import fingerprints ───────────────────────────────────────

const FINGERPRINTS_FILE = () => path.join(PATHS.graph, "import-fingerprints.json");

type Fingerprints = Record<string, string>; // filePath → sha256 of the bytes

function readFingerprints(): Fingerprints {
	try {
		const raw = JSON.parse(fs.readFileSync(FINGERPRINTS_FILE(), "utf8")) as unknown;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Fingerprints : {};
	} catch {
		return {};
	}
}

export function contentHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sourceIdOf(filePath: string): string {
	return `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

/** True when this exact file (path + bytes) already completed an import and
 *  its source is still in the graph (a deleted source imports again). */
export function alreadyImported(filePath: string, hash: string): boolean {
	if (readFingerprints()[filePath] !== hash) return false;
	const id = sourceIdOf(filePath);
	return stores.graphStore.readSources().some((source) => source.id === id);
}

export function recordImported(filePath: string, hash: string): void {
	const all = readFingerprints();
	all[filePath] = hash;
	fs.mkdirSync(path.dirname(FINGERPRINTS_FILE()), { recursive: true });
	writeFileAtomicSync(FINGERPRINTS_FILE(), JSON.stringify(all, null, "\t"));
}
