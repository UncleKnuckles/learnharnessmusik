/**
 * Gemini as a dictation engine (music-study fork).
 *
 * The Dictate button records 16 kHz mono PCM in the renderer (the same
 * worklet Deepgram uses), wraps it in a WAV file, and posts it here when the
 * learner presses Stop. This module sends the audio to the official Gemini
 * API with the learner's Google key (GEMINI_API_KEY, the "Google" provider
 * key) and returns only the transcript. Nothing is posted to a Gemini chat:
 * the text lands in LearnHarness's input and the dictation history.
 *
 * Long recordings are split into WAV pieces that each stay well under the
 * 20 MB inline-request limit, transcribed in order, and joined.
 */
import { keyValue } from "./keys.ts";

export const GEMINI_KEY_ENV = "GEMINI_API_KEY";
/** Tried in order; LH_GEMINI_STT_MODEL (when set) goes first. */
export const GEMINI_STT_MODELS = ["gemini-flash-latest", "gemini-2.5-flash"] as const;
/** 16 kHz × 16-bit mono = 32 000 bytes/s; 4 minutes ≈ 7.7 MB raw, ≈ 10 MB base64. */
export const GEMINI_STT_CHUNK_SECONDS = 240;
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiSttError extends Error {
	constructor(message: string, readonly status = 502) {
		super(message);
		this.name = "GeminiSttError";
	}
}

export type WavPcm = { sampleRate: number; channels: number; bitsPerSample: number; data: Uint8Array };

/** Parse a PCM WAV (RIFF/WAVE, format 1). Throws GeminiSttError(400) when it is not one. */
export function parseWav(bytes: Uint8Array): WavPcm {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new GeminiSttError("Expected a WAV recording", 400);
	let offset = 12;
	let format: Omit<WavPcm, "data"> | null = null;
	while (offset + 8 <= bytes.byteLength) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt ") {
			if (view.getUint16(body, true) !== 1) throw new GeminiSttError("Expected PCM audio", 400);
			format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true) };
		} else if (id === "data") {
			if (!format) throw new GeminiSttError("WAV data before format", 400);
			const end = Math.min(bytes.byteLength, body + size);
			return { ...format, data: bytes.subarray(body, end) };
		}
		offset = body + size + (size % 2);
	}
	throw new GeminiSttError("WAV recording has no audio data", 400);
}

/** Build a PCM WAV file around raw little-endian samples. */
export function wavFile(pcm: Uint8Array, sampleRate = 16000, channels = 1, bitsPerSample = 16): Uint8Array {
	const out = new Uint8Array(44 + pcm.byteLength);
	const view = new DataView(out.buffer);
	const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
	const blockAlign = channels * (bitsPerSample / 8);
	write(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	write(8, "WAVE");
	write(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	write(36, "data");
	view.setUint32(40, pcm.byteLength, true);
	out.set(pcm, 44);
	return out;
}

/** Split a WAV into WAV pieces of at most `seconds` each (block-aligned). */
export function splitWav(wav: WavPcm, seconds = GEMINI_STT_CHUNK_SECONDS): Uint8Array[] {
	const blockAlign = wav.channels * (wav.bitsPerSample / 8);
	const usable = wav.data.byteLength - (wav.data.byteLength % blockAlign);
	if (usable <= 0) return [];
	const step = Math.max(blockAlign, Math.floor(wav.sampleRate * seconds) * blockAlign);
	const pieces: Uint8Array[] = [];
	for (let start = 0; start < usable; start += step) {
		pieces.push(wavFile(wav.data.subarray(start, Math.min(usable, start + step)), wav.sampleRate, wav.channels, wav.bitsPerSample));
	}
	return pieces;
}

/** Seconds of sound in a WAV. */
export function wavSeconds(wav: WavPcm): number {
	return wav.data.byteLength / (wav.sampleRate * wav.channels * (wav.bitsPerSample / 8));
}

/** True when the PCM never rises above a near-silent level (skip the API call). */
export function isSilent(wav: WavPcm, threshold = 200): boolean {
	if (wav.bitsPerSample !== 16) return false;
	const view = new DataView(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength - (wav.data.byteLength % 2));
	for (let i = 0; i < view.byteLength; i += 2) if (Math.abs(view.getInt16(i, true)) > threshold) return false;
	return true;
}

/** The transcription instruction. `language` is the dictation-language setting ("multi" = any). */
export function transcriptionPrompt(language = "multi"): string {
	const hint = language && language !== "multi"
		? `The main spoken language is most likely "${language}", but other languages may appear.`
		: "The speaker usually speaks Russian and may switch to German or English mid-sentence.";
	return [
		"Transcribe this voice recording verbatim.",
		hint,
		"Keep every word in the language and script it was spoken in (Cyrillic for Russian, Latin for German and English). Music-theory terms such as Periode, Satz, Fortspinnung, Kadenz, Dominante or Halbschluss are common: spell them correctly.",
		"Add normal punctuation and capitalization. Do not translate, summarize, answer, or comment.",
		"Output only the transcript. If there is no speech, output nothing.",
	].join(" ");
}

export function geminiModels(env: Record<string, string | undefined> = process.env): string[] {
	const custom = env.LH_GEMINI_STT_MODEL?.trim();
	return [...new Set([...(custom ? [custom] : []), ...GEMINI_STT_MODELS])];
}

type GeminiResponse = {
	candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
	promptFeedback?: { blockReason?: string };
	error?: { message?: string };
};

/** The transcript text in a generateContent response (thought parts skipped). */
export function responseText(body: GeminiResponse): string {
	const parts = body.candidates?.[0]?.content?.parts ?? [];
	return parts.filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join("").trim();
}

export function geminiConfigured(): boolean {
	return Boolean(keyValue(GEMINI_KEY_ENV)?.trim());
}

type Fetch = typeof fetch;

async function transcribePiece(piece: Uint8Array, prompt: string, key: string, models: string[], fetchImpl: Fetch, signal?: AbortSignal): Promise<{ text: string; model: string }> {
	const body = JSON.stringify({
		contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "audio/wav", data: Buffer.from(piece).toString("base64") } }] }],
	});
	let lastError = "Gemini did not answer";
	for (const model of models) {
		let res: Response;
		try {
			res = await fetchImpl(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-goog-api-key": key },
				body,
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new GeminiSttError("Transcription canceled", 499);
			throw new GeminiSttError(`Gemini unreachable: ${error instanceof Error ? error.message : String(error)}`);
		}
		const data = (await res.json().catch(() => ({}))) as GeminiResponse;
		if (res.ok) {
			if (data.promptFeedback?.blockReason) throw new GeminiSttError(`Gemini refused the recording (${data.promptFeedback.blockReason})`);
			return { text: responseText(data), model };
		}
		lastError = data.error?.message ?? `HTTP ${res.status}`;
		// An unknown model name: try the next one. Anything else is final.
		if (res.status === 404) continue;
		if (res.status === 400 && /api key/i.test(lastError)) throw new GeminiSttError("The Google key was rejected. Check it in Settings → Keys.", 401);
		if (res.status === 401 || res.status === 403) throw new GeminiSttError("The Google key was rejected. Check it in Settings → Keys.", 401);
		if (res.status === 429) throw new GeminiSttError("Gemini rate limit reached. Wait a minute and try again.", 429);
		throw new GeminiSttError(`Gemini transcription failed: ${lastError.slice(0, 200)}`);
	}
	throw new GeminiSttError(`No Gemini model is available for transcription (${lastError.slice(0, 160)})`);
}

/** Transcribe one WAV recording. Throws GeminiSttError. */
export async function transcribeWithGemini(
	wavBytes: Uint8Array,
	opts: { language?: string; fetchImpl?: Fetch; key?: string; env?: Record<string, string | undefined>; signal?: AbortSignal } = {},
): Promise<{ text: string; model: string | null; seconds: number }> {
	const key = (opts.key ?? keyValue(GEMINI_KEY_ENV))?.trim();
	if (!key) throw new GeminiSttError("Gemini dictation needs a Google key", 503);
	const wav = parseWav(wavBytes);
	const seconds = wavSeconds(wav);
	if (seconds < 0.3 || isSilent(wav)) return { text: "", model: null, seconds };
	const prompt = transcriptionPrompt(opts.language);
	let models = geminiModels(opts.env);
	const texts: string[] = [];
	let used: string | null = null;
	for (const piece of splitWav(wav)) {
		const { text, model } = await transcribePiece(piece, prompt, key, models, opts.fetchImpl ?? fetch, opts.signal);
		// The first model that answered serves the rest of the recording.
		if (used === null) { used = model; models = [model]; }
		if (text) texts.push(text);
	}
	return { text: texts.join(" ").replace(/\s+/g, " ").trim(), model: used, seconds };
}
