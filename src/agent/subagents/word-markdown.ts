import { unzipSync } from "fflate";
import { DOMParser, parseHTML } from "linkedom";
import WordExtractor from "word-extractor";
import { decodeCodePage, decodeTextBytes } from "../../core/text-decode.ts";

/**
 * Word documents → Markdown (music-study fork, 2026-11-17).
 *
 * - .docx: a zip of XML parts. The main part (word/document.xml) becomes
 *   Markdown with headings (from the paragraph's style or outline level),
 *   bullet and numbered lists (numbering.xml), tables, bold and italic,
 *   links, footnotes and endnotes. Pictures become "[figure: alt]"
 *   placeholders and the text of text boxes is kept. Only the XML parts are
 *   inflated, never the pictures.
 * - .doc (Word 97–2003): plain text through word-extractor, paragraph by
 *   paragraph, with footnotes, endnotes and text boxes.
 * - .rtf, and the many ".doc" files that are really RTF: plain text, with
 *   Cyrillic code pages (\ansicpg, \fcharset) and \u escapes decoded.
 *
 * The result is ONE Markdown text, which then lives exactly like a text
 * file: imported into the graph, stored as lesson material, or read by the
 * agent.
 */

export type WordFailure = "encrypted" | "unreadable" | "empty" | "too-large";

export class WordError extends Error {
	readonly reason: WordFailure;
	constructor(reason: WordFailure, detail: string) {
		super(detail);
		this.name = "WordError";
		this.reason = reason;
	}
}

/** The most XML a .docx may unpack to (declared sizes, checked before inflating). */
export const WORD_MAX_TEXT_BYTES = 50 * 1024 * 1024;

/** The Word file names these converters take. */
export const WORD_FILE = /\.(?:docx|docm|doc|rtf)$/i;

export interface WordMarkdown {
	markdown: string;
	format: "docx" | "doc" | "rtf" | "text";
	/** Pictures and drawings left out (a placeholder marks each). */
	figures: number;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((b, i) => bytes[i] === b);
const isRtf = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes.subarray(0, 16)).trimStart().startsWith("{\\rtf");

/** Why a Word file was refused, in the learner's terms (import, materials and
 *  the read tool share it). Without a name it reads "This Word document …". */
export function wordRefusal(err: unknown, name?: string): string {
	const reason = err instanceof WordError ? err.reason : "unreadable";
	const subject = name ?? "This Word document";
	if (reason === "encrypted") return `${subject} is password-protected. Save it without a password and try again.`;
	if (reason === "empty") return `${subject} has no readable text.`;
	if (reason === "too-large") return `${subject} holds more than ${WORD_MAX_TEXT_BYTES / 1024 / 1024} MB of text.`;
	return name ? `${name} is not a readable Word document.` : "This is not a readable Word document.";
}

/** Any Word file (by its bytes, not its name): .docx, .doc, or RTF. */
export async function wordToMarkdown(bytes: Uint8Array): Promise<WordMarkdown> {
	if (startsWith(bytes, ZIP_MAGIC)) {
		try {
			return docxToMarkdown(bytes);
		} catch (err) {
			if (err instanceof WordError && err.reason !== "unreadable") throw err;
			// An odd producer: word-extractor's own .docx reader may still manage.
			return finish(await extractWithWordExtractor(bytes), "docx", 0);
		}
	}
	if (startsWith(bytes, OLE_MAGIC)) {
		// A password-protected .docx is an OLE file holding an "EncryptedPackage" stream.
		if (Buffer.from(bytes).includes(Buffer.from("EncryptedPackage", "utf16le"))) {
			throw new WordError("encrypted", "the document is encrypted");
		}
		return finish(await extractWithWordExtractor(bytes), "doc", 0);
	}
	if (isRtf(bytes)) return finish(rtfToText(bytes), "rtf", 0);
	// Word also saves plain text or a web page under a .doc name.
	const decoded = decodeTextBytes(bytes);
	if (!decoded) throw new WordError("unreadable", "not a Word, RTF or text file");
	const text = /<html[\s>]/i.test(decoded.text.slice(0, 4096))
		? (parseHTML(decoded.text).document.body?.textContent ?? "")
		: decoded.text;
	return finish(text, "text", 0);
}

function finish(text: string, format: WordMarkdown["format"], figures: number): WordMarkdown {
	const markdown = text
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!markdown) throw new WordError("empty", "the document has no text");
	return { markdown, format, figures };
}

async function extractWithWordExtractor(bytes: Uint8Array): Promise<string> {
	let doc;
	try {
		doc = await new WordExtractor().extract(Buffer.from(bytes));
	} catch (err) {
		throw new WordError("unreadable", err instanceof Error ? err.message : String(err));
	}
	// One paragraph per line in word-extractor's text; Markdown needs a blank line between them.
	const paragraphs = (text: string) => text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n\n");
	// filterUnicode: false keeps dashes and typographic quotes as they are.
	const raw = { filterUnicode: false };
	const parts = [paragraphs(doc.getBody(raw))];
	const boxes = paragraphs(doc.getTextboxes({ ...raw, includeHeadersAndFooters: false }));
	if (boxes) parts.push(boxes);
	const notes = [doc.getFootnotes(raw), doc.getEndnotes(raw)].map(paragraphs).filter(Boolean);
	if (notes.length) parts.push(`---\n\nNotes:\n\n${notes.join("\n\n")}`);
	return parts.join("\n\n");
}

// ─── .docx ───────────────────────────────────────────────────────────────

type El = Element;
const local = (el: El) => el.tagName.replace(/^.*:/, "");
const kids = (el: El) => Array.from(el.children) as El[];
const child = (el: El | undefined, name: string) => (el ? kids(el).find((c) => local(c) === name) : undefined);

/** An attribute by its local name (w:val, r:id …), whatever the prefix. */
function attr(el: El | undefined, name: string): string | null {
	if (!el) return null;
	const direct = el.getAttribute(`w:${name}`) ?? el.getAttribute(name);
	if (direct !== null) return direct;
	for (const a of Array.from(el.attributes)) if (a.name.replace(/^.*:/, "") === name) return a.value;
	return null;
}

/** A toggle property (<w:b/>, <w:b w:val="0"/>). */
function on(el: El | undefined): boolean {
	if (!el) return false;
	const v = attr(el, "val");
	return v === null || !/^(?:0|false|off|none)$/i.test(v);
}

function parseXml(text: string | undefined): Document | null {
	if (!text) return null;
	try {
		return new DOMParser().parseFromString(text, "text/xml") as unknown as Document;
	} catch {
		return null;
	}
}

interface StyleInfo { name: string; basedOn: string | null; outline: number | null; numId: string | null; ilvl: number | null }
interface Rels { [id: string]: { target: string; external: boolean } }

interface DocxContext {
	styles: Map<string, StyleInfo>;
	numbering: Map<string, Map<number, string>>; // numId → ilvl → numFmt
	rels: Rels;
	figures: number;
	noteRefs: Array<{ kind: "fn" | "en"; id: string }>;
}

function readStyles(doc: Document | null): Map<string, StyleInfo> {
	const out = new Map<string, StyleInfo>();
	if (!doc?.documentElement) return out;
	for (const style of kids(doc.documentElement as unknown as El)) {
		if (local(style) !== "style") continue;
		const id = attr(style, "styleId");
		if (!id) continue;
		const pPr = child(style, "pPr");
		const numPr = child(pPr, "numPr");
		const outline = attr(child(pPr, "outlineLvl"), "val");
		const ilvl = attr(child(numPr, "ilvl"), "val");
		out.set(id, {
			name: attr(child(style, "name"), "val") ?? id,
			basedOn: attr(child(style, "basedOn"), "val"),
			outline: outline === null ? null : Number(outline),
			numId: attr(child(numPr, "numId"), "val"),
			ilvl: ilvl === null ? null : Number(ilvl),
		});
	}
	return out;
}

function readNumbering(doc: Document | null): Map<string, Map<number, string>> {
	const out = new Map<string, Map<number, string>>();
	if (!doc?.documentElement) return out;
	const abstract = new Map<string, Map<number, string>>();
	const all = kids(doc.documentElement as unknown as El);
	for (const el of all) {
		if (local(el) !== "abstractNum") continue;
		const levels = new Map<number, string>();
		for (const lvl of kids(el)) {
			if (local(lvl) !== "lvl") continue;
			levels.set(Number(attr(lvl, "ilvl") ?? 0), attr(child(lvl, "numFmt"), "val") ?? "decimal");
		}
		abstract.set(attr(el, "abstractNumId") ?? "", levels);
	}
	for (const el of all) {
		if (local(el) !== "num") continue;
		const levels = abstract.get(attr(child(el, "abstractNumId"), "val") ?? "");
		if (levels) out.set(attr(el, "numId") ?? "", levels);
	}
	return out;
}

function readRels(doc: Document | null): Rels {
	const out: Rels = {};
	if (!doc?.documentElement) return out;
	for (const rel of kids(doc.documentElement as unknown as El)) {
		const id = rel.getAttribute("Id");
		const target = rel.getAttribute("Target");
		if (id && target) out[id] = { target, external: rel.getAttribute("TargetMode") === "External" };
	}
	return out;
}

/** A style property, following basedOn (bounded: a style cycle cannot hang the read). */
function styleChain(ctx: DocxContext, id: string | null): StyleInfo[] {
	const chain: StyleInfo[] = [];
	for (let i = 0; id && i < 20; i++) {
		const style = ctx.styles.get(id);
		if (!style) break;
		chain.push(style);
		id = style.basedOn;
	}
	return chain;
}

interface ParagraphKind { heading: number; list: { marker: string; level: number } | null; skip: boolean }

function paragraphKind(ctx: DocxContext, p: El): ParagraphKind {
	const pPr = child(p, "pPr");
	const chain = styleChain(ctx, attr(child(pPr, "pStyle"), "val"));
	const names = chain.map((s) => s.name.toLowerCase());
	// A table of contents repeats the headings that follow.
	if (names[0] && /^toc\s*\d|^toc heading$|^оглавление/.test(names[0])) return { heading: 0, list: null, skip: true };
	let heading = 0;
	const own = attr(child(pPr, "outlineLvl"), "val");
	const outline = own !== null ? Number(own) : chain.find((s) => s.outline !== null)?.outline ?? null;
	const named = names.map((n) => n.match(/^(?:heading|заголовок)\s*(\d)$/)?.[1]).find(Boolean);
	if (named) heading = Number(named);
	else if (outline !== null && outline >= 0 && outline < 9) heading = outline + 1;
	else if (names[0] === "title") heading = 1;
	if (heading) return { heading: Math.min(heading, 6), list: null, skip: false };
	const numPr = child(pPr, "numPr");
	const numId = attr(child(numPr, "numId"), "val") ?? chain.find((s) => s.numId)?.numId ?? null;
	if (!numId || numId === "0") return { heading: 0, list: null, skip: false };
	const ilvlRaw = attr(child(numPr, "ilvl"), "val");
	const level = ilvlRaw !== null ? Number(ilvlRaw) : chain.find((s) => s.ilvl !== null)?.ilvl ?? 0;
	const format = ctx.numbering.get(numId)?.get(level) ?? "bullet";
	if (format === "none") return { heading: 0, list: null, skip: false };
	return { heading: 0, list: { marker: format === "bullet" ? "-" : "1.", level: Math.max(0, Math.min(level, 8)) }, skip: false };
}

interface Segment { text: string; b: boolean; i: boolean; href: string | null }

/** The runs of a paragraph (or any inline container), in order. */
function inlineSegments(ctx: DocxContext, el: El, out: Segment[], boxes: El[], href: string | null = null): void {
	for (const node of kids(el)) {
		switch (local(node)) {
			case "r": run(ctx, node, out, boxes, href); break;
			case "hyperlink": {
				const rel = ctx.rels[attr(node, "id") ?? ""];
				inlineSegments(ctx, node, out, boxes, rel?.external ? rel.target : href);
				break;
			}
			case "sdt": { const content = child(node, "sdtContent"); if (content) inlineSegments(ctx, content, out, boxes, href); break; }
			case "ins": case "smartTag": case "customXml": case "fldSimple": case "bdo": case "dir": case "moveTo":
				inlineSegments(ctx, node, out, boxes, href);
				break;
			case "AlternateContent": { const choice = child(node, "Choice") ?? child(node, "Fallback"); if (choice) inlineSegments(ctx, choice, out, boxes, href); break; }
			case "oMath": case "oMathPara": {
				const math = mathText(node).trim();
				if (math) out.push({ text: `$${math}$`, b: false, i: false, href: null });
				break;
			}
			default: break; // pPr, bookmarks, proofing marks, deletions, comments
		}
	}
}

function run(ctx: DocxContext, r: El, out: Segment[], boxes: El[], href: string | null): void {
	const rPr = child(r, "rPr");
	if (on(child(rPr, "vanish"))) return; // hidden text
	const b = on(child(rPr, "b"));
	const i = on(child(rPr, "i"));
	const vert = attr(child(rPr, "vertAlign"), "val");
	let text = "";
	for (const node of kids(r)) {
		switch (local(node)) {
			case "t": text += node.textContent ?? ""; break;
			case "tab": case "ptab": text += "\t"; break;
			case "br": case "cr": text += "\n"; break;
			case "noBreakHyphen": text += "-"; break;
			case "footnoteReference": case "endnoteReference": {
				const kind = local(node) === "footnoteReference" ? "fn" : "en";
				const id = attr(node, "id") ?? "";
				ctx.noteRefs.push({ kind, id });
				text += `[^${kind === "fn" ? "" : "e"}${id}]`;
				break;
			}
			case "drawing": case "pict": case "object": text += figure(ctx, node, boxes); break;
			case "AlternateContent": {
				const choice = child(node, "Choice") ?? child(node, "Fallback");
				if (choice) for (const inner of kids(choice)) text += figure(ctx, inner, boxes);
				break;
			}
			default: break; // rPr, delText, instrText, fldChar, softHyphen, sym
		}
	}
	if (!text) return;
	if (vert === "superscript" && /^\S+$/.test(text) && !text.startsWith("[^")) text = `^${text}`;
	out.push({ text, b, i, href });
}

/** A picture's placeholder, or nothing for a text box (its paragraphs follow the paragraph). */
function figure(ctx: DocxContext, el: El, boxes: El[]): string {
	const box = Array.from(el.querySelectorAll("*")).find((n) => local(n as El) === "txbxContent") as El | undefined;
	if (box) { boxes.push(box); return ""; }
	const props = Array.from(el.querySelectorAll("*")).find((n) => local(n as El) === "docPr") as El | undefined;
	const alt = (props?.getAttribute("descr") || props?.getAttribute("title") || "").replace(/\s+/g, " ").trim();
	if (!props && !["drawing", "pict", "object"].includes(local(el))) return "";
	ctx.figures++;
	return alt ? `[figure: ${alt}]` : "[figure]";
}

/** OMML as linear text: fractions as (a)/(b), powers as a^(b), indices as a_(b). */
function mathText(el: El): string {
	let out = "";
	for (const node of kids(el)) {
		const name = local(node);
		const raw = (n: string) => mathText(child(node, n) ?? node.ownerDocument.createElement("x"));
		// A single symbol needs no parentheses: a^2, not a^(2).
		const part = (n: string) => { const text = raw(n).trim(); return /^[\p{L}\p{N}]+$/u.test(text) ? text : `(${text})`; };
		if (name === "t") out += node.textContent ?? "";
		else if (name === "f") out += `${part("num")}/${part("den")}`;
		else if (name === "sSup") out += `${raw("e")}^${part("sup")}`;
		else if (name === "sSub") out += `${raw("e")}_${part("sub")}`;
		else if (name === "sSubSup") out += `${raw("e")}_${part("sub")}^${part("sup")}`;
		else if (name === "rad") out += `√${part("e")}`;
		else if (!/Pr$/.test(name)) out += mathText(node);
	}
	return out;
}

/** Segments → Markdown, merging runs with the same formatting. */
function formatSegments(segments: Segment[]): string {
	const merged: Segment[] = [];
	for (const s of segments) {
		const last = merged.at(-1);
		if (last && last.b === s.b && last.i === s.i && last.href === s.href) last.text += s.text;
		else merged.push({ ...s });
	}
	return merged.map((s) => {
		let text = s.text.replace(/\t/g, " ");
		const mark = s.b && s.i ? "***" : s.b ? "**" : s.i ? "*" : "";
		if (mark && text.trim()) {
			const lead = text.match(/^\s*/)![0];
			const trail = text.match(/\s*$/)![0];
			text = `${lead}${mark}${text.trim()}${mark}${trail}`;
		}
		if (s.href && text.trim() && /^(?:https?|mailto):/i.test(s.href)) text = `[${text.trim()}](${s.href})`;
		return text;
	}).join("");
}

/** list: the item's marker ("-" or "1.") and level, so a change of list type starts a new list. */
interface Block { text: string; list: string | null; level?: number }

function paragraphBlocks(ctx: DocxContext, p: El, blocks: Block[]): void {
	const kind = paragraphKind(ctx, p);
	if (kind.skip) return;
	const segments: Segment[] = [];
	const boxes: El[] = [];
	inlineSegments(ctx, p, segments, boxes);
	let text = formatSegments(segments).replace(/ *\n */g, "\n").replace(/ {2,}/g, " ").trim();
	if (text) {
		if (kind.heading) blocks.push({ text: `${"#".repeat(kind.heading)} ${text.replace(/\*+/g, "").replace(/\n/g, " ").trim()}`, list: null });
		else if (kind.list) {
			text = text.replace(/\n/g, `\n${"    ".repeat(kind.list.level)}  `);
			blocks.push({ text: `${"    ".repeat(kind.list.level)}${kind.list.marker} ${text}`, list: kind.list.marker, level: kind.list.level });
		} else blocks.push({ text, list: null });
	}
	for (const box of boxes) bodyBlocks(ctx, box, blocks);
}

function cellText(ctx: DocxContext, tc: El): string {
	const inner: Block[] = [];
	bodyBlocks(ctx, tc, inner);
	return inner.map((b) => b.text).join("<br>").replace(/\n/g, "<br>").replace(/\|/g, "\\|").trim();
}

function tableBlocks(ctx: DocxContext, tbl: El, blocks: Block[]): void {
	const rows: string[][] = [];
	const rowsOf = (el: El): El[] => kids(el).flatMap((n) => {
		const name = local(n);
		if (name === "tr") return [n];
		if (name === "sdt") { const c = child(n, "sdtContent"); return c ? rowsOf(c) : []; }
		if (name === "customXml") return rowsOf(n);
		return [];
	});
	const cellsOf = (el: El): El[] => kids(el).flatMap((n) => {
		const name = local(n);
		if (name === "tc") return [n];
		if (name === "sdt") { const c = child(n, "sdtContent"); return c ? cellsOf(c) : []; }
		if (name === "customXml") return cellsOf(n);
		return [];
	});
	for (const tr of rowsOf(tbl)) {
		const row: string[] = [];
		for (const tc of cellsOf(tr)) {
			const tcPr = child(tc, "tcPr");
			const vMerge = child(tcPr, "vMerge");
			const continued = vMerge !== undefined && attr(vMerge, "val") !== "restart";
			row.push(continued ? "" : cellText(ctx, tc));
			const span = Number(attr(child(tcPr, "gridSpan"), "val") ?? 1);
			for (let k = 1; k < span && k < 64; k++) row.push("");
		}
		if (row.length) rows.push(row);
	}
	if (rows.length === 0) return;
	const width = Math.max(...rows.map((r) => r.length));
	// A one-cell or one-column table is a layout box: its content reads as paragraphs.
	if (width === 1) {
		for (const row of rows) for (const cell of row) if (cell) blocks.push({ text: cell.replace(/<br>/g, "\n\n").replace(/\\\|/g, "|"), list: null });
		return;
	}
	if (rows.every((r) => r.every((c) => !c))) return;
	const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, k) => cells[k] ?? "").join(" | ")} |`;
	const [head, ...body] = rows;
	blocks.push({ text: [line(head!), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join("\n"), list: null });
}

function bodyBlocks(ctx: DocxContext, el: El, blocks: Block[]): void {
	for (const node of kids(el)) {
		switch (local(node)) {
			case "p": paragraphBlocks(ctx, node, blocks); break;
			case "tbl": tableBlocks(ctx, node, blocks); break;
			case "sdt": { const content = child(node, "sdtContent"); if (content) bodyBlocks(ctx, content, blocks); break; }
			case "customXml": case "ins": case "moveTo": bodyBlocks(ctx, node, blocks); break;
			case "AlternateContent": { const choice = child(node, "Choice") ?? child(node, "Fallback"); if (choice) bodyBlocks(ctx, choice, blocks); break; }
			default: break; // sectPr, bookmarks, deletions
		}
	}
}

function joinBlocks(blocks: Block[]): string {
	let out = "";
	blocks.forEach((block, k) => {
		const previous = blocks[k - 1];
		// One list continues across its levels; a new type of list at the top level starts a new one.
		const sameList = previous?.list && block.list && (previous.list === block.list || (previous.level ?? 0) > 0 || (block.level ?? 0) > 0);
		if (k > 0) out += sameList ? "\n" : "\n\n";
		out += block.text;
	});
	return out;
}

/** Footnotes or endnotes by id (separators are not notes). */
function readNotes(ctx: DocxContext, doc: Document | null): Map<string, string> {
	const out = new Map<string, string>();
	if (!doc?.documentElement) return out;
	for (const note of kids(doc.documentElement as unknown as El)) {
		if (!["footnote", "endnote"].includes(local(note))) continue;
		const type = attr(note, "type");
		if (type && type !== "normal") continue;
		const blocks: Block[] = [];
		bodyBlocks(ctx, note, blocks);
		const text = blocks.map((b) => b.text).join(" ").replace(/\s+/g, " ").trim();
		if (text) out.set(attr(note, "id") ?? "", text);
	}
	return out;
}

/** The zip's parts, inflating only those asked for, within the text ceiling. */
function zipParts(bytes: Uint8Array, names: ReadonlySet<string>, maxTextBytes: number): Map<string, string> {
	let total = 0;
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes, {
			filter: (file) => {
				if (!names.has(file.name)) return false;
				total += file.originalSize;
				if (total > maxTextBytes) throw new WordError("too-large", "the document's text is over the size ceiling");
				return true;
			},
		});
	} catch (err) {
		if (err instanceof WordError) throw err;
		throw new WordError("unreadable", "the file is not a readable zip");
	}
	const decoder = new TextDecoder("utf-8");
	return new Map(Object.entries(files).map(([name, data]) => [name, decoder.decode(data)]));
}

/** The main document part named by the package relationships (almost always word/document.xml). */
function mainPartName(bytes: Uint8Array, maxTextBytes: number): string {
	const rels = parseXml(zipParts(bytes, new Set(["_rels/.rels"]), maxTextBytes).get("_rels/.rels"));
	for (const rel of rels?.documentElement ? kids(rels.documentElement as unknown as El) : []) {
		if (/\/officeDocument$/.test(rel.getAttribute("Type") ?? "")) return (rel.getAttribute("Target") ?? "").replace(/^\//, "");
	}
	return "word/document.xml";
}

/** A .docx (or .docm) as Markdown. Synchronous; throws WordError. */
export function docxToMarkdown(bytes: Uint8Array, maxTextBytes = WORD_MAX_TEXT_BYTES): WordMarkdown {
	const main = mainPartName(bytes, maxTextBytes);
	const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
	const relsName = `${dir}_rels/${main.slice(dir.length)}.rels`;
	const parts = zipParts(bytes, new Set([main, relsName, `${dir}styles.xml`, `${dir}numbering.xml`, `${dir}footnotes.xml`, `${dir}endnotes.xml`]), maxTextBytes);
	const document = parseXml(parts.get(main));
	const body = document?.documentElement ? child(document.documentElement as unknown as El, "body") : undefined;
	if (!body) throw new WordError("unreadable", "the document has no body");
	const ctx: DocxContext = {
		styles: readStyles(parseXml(parts.get(`${dir}styles.xml`))),
		numbering: readNumbering(parseXml(parts.get(`${dir}numbering.xml`))),
		rels: readRels(parseXml(parts.get(relsName))),
		figures: 0,
		noteRefs: [],
	};
	const blocks: Block[] = [];
	bodyBlocks(ctx, body, blocks);
	let markdown = joinBlocks(blocks);
	if (ctx.noteRefs.length) {
		const footnotes = readNotes(ctx, parseXml(parts.get(`${dir}footnotes.xml`)));
		const endnotes = readNotes(ctx, parseXml(parts.get(`${dir}endnotes.xml`)));
		const lines = ctx.noteRefs.flatMap(({ kind, id }) => {
			const text = (kind === "fn" ? footnotes : endnotes).get(id);
			return text ? [`[^${kind === "fn" ? "" : "e"}${id}]: ${text}`] : [];
		});
		if (lines.length) markdown += `\n\n${[...new Set(lines)].join("\n")}`;
	}
	return finish(markdown, "docx", ctx.figures);
}

// ─── RTF ─────────────────────────────────────────────────────────────────

/** Destinations whose text is not document text. */
const RTF_SKIP = new Set([
	"fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "headerl", "headerr", "headerf", "footer", "footerl",
	"footerr", "footerf", "fldinst", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "listtable",
	"listoverridetable", "rsidtbl", "generator", "mmathPr", "pgdsctbl", "revtbl", "filetbl", "bkmkstart", "bkmkend", "nonshppict",
	"shpinst", "userprops", "docvar", "ftnsep", "ftnsepc", "aftnsep", "aftnsepc", "private", "atnid", "atnauthor", "annotation",
	"wgrffmtfilter", "passwordhash", "pn", "pnseclvl", "file", "objdata", "blipuid", "sp", "sn", "sv", "shprslt",
]);

/** Windows code pages of RTF font charsets this reader decodes. */
const CHARSET_CODEPAGE: Record<number, "windows-1251" | "windows-1252"> = { 0: "windows-1252", 204: "windows-1251" };

/** RTF → plain text (paragraphs separated by blank lines; table cells by " | "). Pure. */
export function rtfToText(bytes: Uint8Array): string {
	const src = new TextDecoder("latin1").decode(bytes);
	let codepage: "windows-1251" | "windows-1252" = "windows-1252";
	const fontPage = new Map<number, "windows-1251" | "windows-1252">();
	type State = { skip: boolean; uc: number; font: number | null; fonttbl: boolean };
	let state: State = { skip: false, uc: 1, font: null, fonttbl: false };
	const stack: State[] = [];
	let out = "";
	let pendingBytes: number[] = [];
	let skipChars = 0;
	let tableFont: number | null = null;
	const flushBytes = () => {
		if (pendingBytes.length === 0) return;
		const page = (state.font !== null ? fontPage.get(state.font) : undefined) ?? codepage;
		if (!state.skip) out += decodeCodePage(new Uint8Array(pendingBytes), page);
		pendingBytes = [];
	};
	const emit = (text: string) => { flushBytes(); if (!state.skip) out += text; };
	let i = 0;
	let groupStart = false;
	while (i < src.length) {
		const ch = src[i]!;
		if (ch === "{") {
			flushBytes();
			stack.push(state);
			state = { ...state };
			groupStart = true;
			skipChars = 0;
			i++;
			continue;
		}
		if (ch === "}") {
			flushBytes();
			state = stack.pop() ?? state;
			groupStart = false;
			skipChars = 0;
			i++;
			continue;
		}
		if (ch === "\r" || ch === "\n") { i++; continue; }
		if (ch !== "\\") {
			groupStart = false;
			if (skipChars > 0) { skipChars--; i++; continue; }
			if (state.fonttbl) { i++; continue; }
			const code = ch.charCodeAt(0);
			if (code >= 0x80) pendingBytes.push(code);
			else emit(ch);
			i++;
			continue;
		}
		// A control symbol or control word.
		const next = src[i + 1] ?? "";
		if (next === "'") {
			const byte = parseInt(src.slice(i + 2, i + 4), 16);
			i += 4;
			if (skipChars > 0) { skipChars--; continue; }
			if (!Number.isNaN(byte) && !state.fonttbl) pendingBytes.push(byte);
			continue;
		}
		if (!/[a-zA-Z]/.test(next)) {
			i += 2;
			const wasStart = groupStart;
			groupStart = false;
			if (next === "*" && wasStart) { state.skip = true; continue; }
			if (skipChars > 0) { skipChars--; continue; }
			if (next === "\\" || next === "{" || next === "}") emit(next);
			else if (next === "~") emit("\u00A0");
			else if (next === "_") emit("-");
			else if (next === "\n" || next === "\r") emit("\n");
			continue;
		}
		const m = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i, i + 48));
		if (!m) { i++; continue; }
		i += m[0].length;
		const word = m[1]!;
		const param = m[2] === undefined ? null : Number(m[2]);
		const wasStart = groupStart;
		groupStart = false;
		if (word === "bin" && param) { flushBytes(); i += param; continue; }
		if (word === "u" && param !== null) {
			flushBytes();
			emit(String.fromCharCode(param < 0 ? param + 65536 : param));
			skipChars = state.uc;
			continue;
		}
		// A \u's fallback may be a control word too: it is skipped like a character.
		if (skipChars > 0) { skipChars--; continue; }
		if (wasStart && RTF_SKIP.has(word)) {
			if (word === "fonttbl") state.fonttbl = true;
			else state.skip = true;
			if (word !== "fonttbl") continue;
		}
		switch (word) {
			case "ansicpg": if (param === 1251) codepage = "windows-1251"; else if (param === 1252) codepage = "windows-1252"; break;
			case "uc": if (param !== null) state.uc = param; break;
			case "f":
				flushBytes();
				if (state.fonttbl && param !== null) tableFont = param;
				else state.font = param;
				break;
			case "fcharset":
				if (state.fonttbl && tableFont !== null && param !== null && CHARSET_CODEPAGE[param]) fontPage.set(tableFont, CHARSET_CODEPAGE[param]!);
				break;
			case "par": case "line": case "sect": case "page": emit("\n"); break;
			case "tab": emit("\t"); break;
			case "cell": emit(" | "); break;
			case "row": emit("\n"); break;
			case "emdash": emit("—"); break;
			case "endash": emit("–"); break;
			case "bullet": emit("•"); break;
			case "lquote": emit("‘"); break;
			case "rquote": emit("’"); break;
			case "ldblquote": emit("“"); break;
			case "rdblquote": emit("”"); break;
			case "emspace": case "enspace": case "qmspace": emit(" "); break;
			default: break;
		}
	}
	flushBytes();
	return out
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\t/g, " ").replace(/ {2,}/g, " ").replace(/(?:\s*\|\s*)+$/, "").trim())
		// A Symbol or Wingdings bullet (a private-use character) marks a list item.
		.map((line) => line.replace(/^(?:[\uE000-\uF8FF•·▪]\s*|[–—]\s+)/, "- ").replace(/[\uE000-\uF8FF]/g, ""))
		.filter(Boolean)
		.join("\n\n");
}
