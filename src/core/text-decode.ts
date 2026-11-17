/**
 * Text files in any common encoding (music-study fork, 2026-11-17). PURE,
 * browser-safe.
 *
 * Plain text from Windows is often not UTF-8: Notepad's "Unicode" is
 * UTF-16 (full of zero bytes, so it looked binary), and older Russian
 * files are Windows-1251 (which decoded as garbage). This picks the
 * encoding from the bytes:
 *
 * 1. A byte-order mark: UTF-8, UTF-16 LE or UTF-16 BE.
 * 2. Zero bytes that sit on every other byte: UTF-16 without a mark.
 *    Other zero bytes in the first 8 KiB mean the file is binary.
 * 3. Valid UTF-8 (plain ASCII is valid UTF-8 too).
 * 4. Otherwise a Windows code page: 1251 (Cyrillic) or 1252 (Western
 *    European: German umlauts, ß), whichever reads as real words.
 *
 * The code pages are tables here, so the result never depends on which
 * encodings the runtime's TextDecoder happens to ship.
 */

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1251" | "windows-1252";

export interface DecodedText {
	text: string;
	encoding: TextEncodingName;
}

/** The first bytes checked for zero bytes (binary detection, upstream's 8 KiB). */
export const BINARY_SNIFF_BYTES = 8192;

/** Windows-1251, bytes 0x80–0xFF. */
const CP1251_HIGH =
	"\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F" +
	"\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u0098\u2122\u0459\u203A\u045A\u045C\u045B\u045F" +
	"\u00A0\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407" +
	"\u00B0\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457" +
	Array.from({ length: 64 }, (_, i) => String.fromCharCode(0x0410 + i)).join("");

/** Windows-1252, bytes 0x80–0xFF (0xA0–0xFF are Latin-1). */
const CP1252_HIGH =
	"\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F" +
	"\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178" +
	Array.from({ length: 96 }, (_, i) => String.fromCharCode(0xA0 + i)).join("");

function singleByte(bytes: Uint8Array, high: string): string {
	let out = "";
	const CHUNK = 8192;
	for (let start = 0; start < bytes.length; start += CHUNK) {
		const end = Math.min(bytes.length, start + CHUNK);
		const chars: string[] = new Array(end - start);
		for (let i = start; i < end; i++) {
			const b = bytes[i]!;
			chars[i - start] = b < 0x80 ? String.fromCharCode(b) : high[b - 0x80]!;
		}
		out += chars.join("");
	}
	return out;
}

/** Decode a Windows code page this module knows. */
export function decodeCodePage(bytes: Uint8Array, encoding: "windows-1251" | "windows-1252"): string {
	return singleByte(bytes, encoding === "windows-1251" ? CP1251_HIGH : CP1252_HIGH);
}

/** UTF-16 (BE is byte-swapped to LE: small-ICU runtimes ship only LE). */
function utf16(bytes: Uint8Array, encoding: "utf-16le" | "utf-16be"): string | null {
	let le = bytes.subarray(0, bytes.length - (bytes.length % 2));
	if (encoding === "utf-16be") {
		le = new Uint8Array(le);
		for (let i = 0; i + 1 < le.length; i += 2) { const b = le[i]!; le[i] = le[i + 1]!; le[i + 1] = b; }
	}
	try {
		return new TextDecoder("utf-16le", { fatal: true }).decode(le);
	} catch {
		return null;
	}
}

/** UTF-16 without a mark: zero bytes on one parity only (the high byte of
 *  Latin text, spaces, digits and punctuation). */
function utf16Parity(sample: Uint8Array): "utf-16le" | "utf-16be" | null {
	const half = Math.floor(sample.length / 2);
	if (half < 2) return null;
	let evenZeros = 0;
	let oddZeros = 0;
	for (let i = 0; i + 1 < sample.length; i += 2) {
		if (sample[i] === 0) evenZeros++;
		if (sample[i + 1] === 0) oddZeros++;
	}
	const dominant = Math.max(evenZeros, oddZeros);
	const other = Math.min(evenZeros, oddZeros);
	if (dominant / half < 0.05 || other / half > 0.01) return null;
	return oddZeros > evenZeros ? "utf-16le" : "utf-16be";
}

/**
 * Cyrillic (1251) or Western (1252), by which reading gives real words:
 * read as 1251, German text turns into words that mix Latin and Cyrillic
 * letters ("GrьЯe"); read as 1252, Russian text turns into words made
 * mostly of accented letters ("Ïåðèîä"). Fewer such words wins; a tie goes
 * to the share of letters written as high bytes.
 */
function codePageFor(bytes: Uint8Array): "windows-1251" | "windows-1252" {
	const sample = bytes.subarray(0, 64 * 1024);
	const words = (text: string) => text.split(/[^\p{L}]+/u).filter((word) => word.length >= 2);
	const mixed = words(decodeCodePage(sample, "windows-1251"))
		.filter((word) => /[A-Za-z]/.test(word) && /\p{Script=Cyrillic}/u.test(word)).length;
	const accented = words(decodeCodePage(sample, "windows-1252"))
		.filter((word) => word.replace(/[A-Za-z]/g, "").length * 2 > word.length).length;
	if (mixed !== accented) return mixed < accented ? "windows-1251" : "windows-1252";
	let ascii = 0;
	let high = 0;
	for (const b of sample) {
		if ((b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)) ascii++;
		else if (b >= 0xC0 || b === 0xA8 || b === 0xB8) high++;
	}
	return high > 0 && high / (ascii + high) > 0.3 ? "windows-1251" : "windows-1252";
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

/**
 * Decode a text file's bytes, or null when they look binary (zero bytes in
 * the first 8 KiB that are not UTF-16). Pure.
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText | null {
	if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
		return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
	}
	if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
		const text = utf16(bytes.subarray(2), "utf-16le");
		if (text !== null) return { text: stripBom(text), encoding: "utf-16le" };
	}
	if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
		const text = utf16(bytes.subarray(2), "utf-16be");
		if (text !== null) return { text: stripBom(text), encoding: "utf-16be" };
	}
	const sample = bytes.subarray(0, BINARY_SNIFF_BYTES);
	if (sample.includes(0)) {
		const parity = utf16Parity(sample);
		const text = parity ? utf16(bytes, parity) : null;
		return text === null || !parity ? null : { text, encoding: parity };
	}
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
	} catch {
		const encoding = codePageFor(bytes);
		return { text: decodeCodePage(bytes, encoding), encoding };
	}
}
