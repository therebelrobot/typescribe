/** XML text/attribute escaping and the date format OOXML expects. */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strip characters that are illegal in XML 1.0 regardless of escaping.
 * ASR output occasionally carries control bytes through from the decoder.
 */
export function sanitizeText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** `w:date` and `dcterms:*` both want W3CDTF with no sub-second component. */
export function ooxmlDate(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export const XML_DECL =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
