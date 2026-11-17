import { strToU8, zipSync } from "fflate";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="My section"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

export const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
</w:numbering>`;

export interface DocxSpec {
	/** The children of <w:body>. */
	body: string;
	footnotes?: string;
	rels?: string;
	extra?: Record<string, string | Uint8Array>;
	/** Leave out styles.xml and numbering.xml. */
	bare?: boolean;
}

/** A .docx as bytes: the package parts around the given body XML. */
export function docx(spec: DocxSpec): Uint8Array {
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
		"_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
		"word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${spec.body}<w:sectPr/></w:body></w:document>`),
		"word/_rels/document.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.rels ?? ""}</Relationships>`),
		"word/media/image1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	};
	if (!spec.bare) {
		files["word/styles.xml"] = strToU8(STYLES);
		files["word/numbering.xml"] = strToU8(NUMBERING);
	}
	if (spec.footnotes) files["word/footnotes.xml"] = strToU8(`<?xml version="1.0"?><w:footnotes xmlns:w="${W}">${spec.footnotes}</w:footnotes>`);
	for (const [name, data] of Object.entries(spec.extra ?? {})) files[name] = typeof data === "string" ? strToU8(data) : data;
	return zipSync(files);
}

/** A paragraph: optional style, then runs given as text or [text, "b" | "i" | "bi"]. */
export function p(runs: Array<string | [string, string]>, opts: { style?: string; numId?: number; ilvl?: number } = {}): string {
	const pPr = opts.style || opts.numId !== undefined
		? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${opts.numId !== undefined ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>` : ""}</w:pPr>`
		: "";
	return `<w:p>${pPr}${runs.map((r) => {
		const [text, fmt] = typeof r === "string" ? [r, ""] : r;
		const rPr = fmt ? `<w:rPr>${fmt.includes("b") ? "<w:b/>" : ""}${fmt.includes("i") ? "<w:i/>" : ""}</w:rPr>` : "";
		return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
	}).join("")}</w:p>`;
}
