// Collapse all and expand all for the stacked Diff (ticket 374). Ported from T3 Code
// apps/web/src/lib/diffCollapse.ts:1-13, MIT License, Copyright (c) 2026 T3 Tools Inc. (THIRD_PARTY_NOTICES.md).
export function areAllDiffFilesCollapsed(fileKeys: ReadonlyArray<string>, collapsedFileKeys: ReadonlySet<string>): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

export function toggleAllDiffFiles(fileKeys: ReadonlyArray<string>, collapsedFileKeys: ReadonlySet<string>): ReadonlySet<string> {
  return areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? new Set() : new Set(fileKeys);
}
