// A note on one diff line, as text for the composer (ticket 374). Shape and escaping ported from Orca
// src/shared/diff-comments-format.ts:9-22, MIT License, Copyright (c) 2026 Lovecast Inc. (THIRD_PARTY_NOTICES.md).
// Why (Orca): the pasted format is the contract between review notes and whichever agent consumes them; keep it
// deterministic and quote-safe.
export function formatLineNote(filePath: string, lineNumber: number, body: string): string {
  const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return [`File: ${filePath}`, `Line: ${lineNumber}`, `User comment: "${escaped}"`].join('\n');
}
