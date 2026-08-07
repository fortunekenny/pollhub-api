/**
 * Minimal RFC 4180 CSV writer.
 *
 * The leading-quote guard blocks CSV injection: a respondent answering
 * `=cmd|'/c calc'!A1` in a free-text question would otherwise execute on the
 * creator's machine when they open the export in Excel.
 */
const RISKY_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (RISKY_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  // BOM so Excel opens UTF-8 exports without mangling non-ASCII names.
  return `﻿${lines.join('\r\n')}\r\n`;
}
