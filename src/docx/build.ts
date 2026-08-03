/**
 * Builds the .docx package.
 *
 * Every run of text is wrapped in `<w:ins>` carrying the wall-clock time the
 * typing model says it landed, and every paragraph mark except the document's
 * final one is likewise marked inserted (that last mark exists in a blank
 * document before anyone types, so it is not an insertion).
 *
 * Note on what this deliberately does not do: it emits no fabricated
 * typo/correction pairs and no synthetic `rsid` save-session identifiers. Those
 * two features exist only to make machine output survive forensic authorship
 * examination, which is a different product from "show the transcript arriving
 * in time with the audio". The revision marks here are visible in Word's normal
 * review pane, and `docProps/app.xml` names the generator.
 */

import { createZip, type ZipEntry } from "./zip.ts";
import { escapeXml, ooxmlDate, sanitizeText, XML_DECL } from "./xml.ts";
import { formatClock, type TypingPlan } from "../typing.ts";

export interface DocxOptions {
  title: string;
  author: string;
  /** Prefix each paragraph with its `[mm:ss]` position in the audio. */
  timestamps: boolean;
  generator: string;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export function buildDocx(plan: TypingPlan, options: DocxOptions): Buffer {
  let revisionId = 1;
  const nextId = () => revisionId++;

  const body: string[] = [];

  for (let index = 0; index < plan.paragraphs.length; index++) {
    const paragraph = plan.paragraphs[index]!;
    const isLast = index === plan.paragraphs.length - 1;
    const runs: string[] = [];

    if (options.timestamps) {
      const stamp = `[${formatClock(paragraph.audioStart)}] `;
      const at = ooxmlDate(paragraph.chunks[0]?.typedAt ?? paragraph.markTypedAt);
      runs.push(
        insWrap(
          nextId(),
          options.author,
          at,
          `<w:r><w:rPr><w:rStyle w:val="Timestamp"/></w:rPr>${textElement(stamp)}</w:r>`,
        ),
      );
    }

    for (const chunk of paragraph.chunks) {
      runs.push(
        insWrap(
          nextId(),
          options.author,
          ooxmlDate(chunk.typedAt),
          `<w:r>${textElement(chunk.text)}</w:r>`,
        ),
      );
    }

    // `w:rPr` must be the last child of `w:pPr`, and `w:ins` the first child of
    // that `w:rPr` — both orderings are schema-enforced, not stylistic.
    const markRpr = isLast
      ? ""
      : `<w:rPr><w:ins w:id="${nextId()}" w:author="${escapeXml(options.author)}" w:date="${ooxmlDate(paragraph.markTypedAt)}"/></w:rPr>`;

    body.push(
      `<w:p><w:pPr><w:pStyle w:val="Transcript"/>${markRpr}</w:pPr>${runs.join("")}</w:p>`,
    );
  }

  if (!body.length) {
    body.push('<w:p><w:pPr><w:pStyle w:val="Transcript"/></w:pPr></w:p>');
  }

  const documentXml =
    XML_DECL +
    `<w:document xmlns:w="${W_NS}">` +
    `<w:body>${body.join("")}${sectPr()}</w:body>` +
    `</w:document>`;

  const mtime = plan.sessionEnd;
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: contentTypes(), mtime, store: true },
    { path: "_rels/.rels", data: packageRels(), mtime },
    { path: "word/document.xml", data: documentXml, mtime },
    { path: "word/_rels/document.xml.rels", data: documentRels(), mtime },
    { path: "word/styles.xml", data: stylesXml(), mtime },
    { path: "word/settings.xml", data: settingsXml(), mtime },
    { path: "docProps/core.xml", data: coreXml(plan, options), mtime },
    { path: "docProps/app.xml", data: appXml(plan, options), mtime },
  ];

  return createZip(entries);
}

function insWrap(id: number, author: string, date: string, inner: string): string {
  return `<w:ins w:id="${id}" w:author="${escapeXml(author)}" w:date="${date}">${inner}</w:ins>`;
}

function textElement(text: string): string {
  return `<w:t xml:space="preserve">${escapeXml(sanitizeText(text))}</w:t>`;
}

function sectPr(): string {
  // US Letter in DXA (1440 per inch), 1" margins.
  return (
    `<w:sectPr>` +
    `<w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
    `<w:cols w:space="720"/>` +
    `<w:docGrid w:linePitch="360"/>` +
    `</w:sectPr>`
  );
}

function contentTypes(): string {
  return (
    XML_DECL +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`
  );
}

function packageRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`
  );
}

function documentRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
    `</Relationships>`
  );
}

function stylesXml(): string {
  return (
    XML_DECL +
    `<w:styles xmlns:w="${W_NS}">` +
    `<w:docDefaults>` +
    `<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="278" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
    `</w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal">` +
    `<w:name w:val="Normal"/><w:qFormat/>` +
    `</w:style>` +
    `<w:style w:type="paragraph" w:styleId="Transcript">` +
    `<w:name w:val="Transcript"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>` +
    `</w:style>` +
    `<w:style w:type="character" w:styleId="Timestamp">` +
    `<w:name w:val="Timestamp"/>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:color w:val="6A6A6A"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
    `</w:style>` +
    `</w:styles>`
  );
}

function settingsXml(): string {
  // `w:trackRevisions` leaves the document in recording mode, which is the state
  // a live-typed transcript would actually be saved in.
  return (
    XML_DECL +
    `<w:settings xmlns:w="${W_NS}">` +
    `<w:trackRevisions/>` +
    `<w:defaultTabStop w:val="720"/>` +
    `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>` +
    `</w:settings>`
  );
}

function coreXml(plan: TypingPlan, options: DocxOptions): string {
  return (
    XML_DECL +
    `<cp:coreProperties ` +
    `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(options.title)}</dc:title>` +
    `<dc:creator>${escapeXml(options.author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(options.author)}</cp:lastModifiedBy>` +
    `<cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${ooxmlDate(plan.sessionStart)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${ooxmlDate(plan.sessionEnd)}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

function appXml(plan: TypingPlan, options: DocxOptions): string {
  const minutes = Math.max(
    1,
    Math.round((plan.sessionEnd.getTime() - plan.sessionStart.getTime()) / 60000),
  );
  const withoutSpaces = plan.characterCount - plan.wordCount;
  // Child order in CT_Properties is schema-enforced.
  return (
    XML_DECL +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Template>Normal.dotm</Template>` +
    `<Company></Company>` +
    `<Words>${plan.wordCount}</Words>` +
    `<Characters>${Math.max(0, withoutSpaces)}</Characters>` +
    `<Lines>${Math.max(1, Math.ceil(plan.characterCount / 90))}</Lines>` +
    `<Paragraphs>${plan.paragraphs.length}</Paragraphs>` +
    `<TotalTime>${minutes}</TotalTime>` +
    `<CharactersWithSpaces>${plan.characterCount}</CharactersWithSpaces>` +
    `<Application>${escapeXml(options.generator)}</Application>` +
    `<AppVersion>0.1</AppVersion>` +
    `<DocSecurity>0</DocSecurity>` +
    `</Properties>`
  );
}
