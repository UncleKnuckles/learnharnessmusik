/**
 * Import size limits. The music-study fork lifts the upstream caps (25 MB per
 * request, 1,000 PDF pages) to the practical ceiling of one in-memory upload:
 * 2 GiB per request and effectively unlimited pages. The test suite keeps the
 * upstream values so its boundary tests stay cheap to run.
 */
const TESTING = process.env.NODE_ENV === "test";
const MiB = 1024 * 1024;

/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = TESTING ? 25 * MiB : 2048 * MiB;
export const MAX_IMPORT_BODY_BYTES = MAX_IMPORT_BYTES + MiB;
/** PDF pages converted per file. */
export const MAX_PDF_PAGES = TESTING ? 1000 : 1_000_000;

/** The file types "Extract files" takes; the client check, server check and picker `accept` all derive from this list.
 * Text and PDF as upstream, plus images (vision transcription) and audio (Deepgram transcription). */
const IMPORT_EXTENSION_NAMES = [
	"txt", "md", "markdown", "rst", "org", "adoc", "tex", "pdf",
	"png", "jpg", "jpeg", "webp",
	"mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "webm",
];
export const IMPORT_EXTENSIONS = new RegExp(`\\.(?:${IMPORT_EXTENSION_NAMES.join("|")})$`, "i");
export const IMPORT_ACCEPT = IMPORT_EXTENSION_NAMES.map((name) => `.${name}`).join(",");
export const UNSUPPORTED_TYPE_MESSAGE = "This file type isn't supported. Use text, Markdown, PDF, an image, or audio.";

/** "25 MB", "2 GB" — the refusal text shown beside a file. */
export function importLimitLabel(bytes: number = MAX_IMPORT_BYTES): string {
	return bytes >= 1024 * MiB ? `${Math.round(bytes / (1024 * MiB))} GB` : `${Math.round(bytes / MiB)} MB`;
}
export const TOO_BIG_MESSAGE = `Too big. Max ${importLimitLabel()}.`;
export const TOO_LONG_MESSAGE = `Too long. Max ${MAX_PDF_PAGES.toLocaleString("en-US")} pages.`;

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
