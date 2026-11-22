// V2.5-33d (ticket 169): a feature registers its Settings page from one file. Pure model checks, no page.
import { expect, test } from '@playwright/test';
import { FIELDS, PAGES } from '../src/settings';
import { registerSettingsPage } from '../src/features/registry';

// Playwright reuses a worker across spec files and the registry is module state: leave it as found.
const [pages, fields] = [PAGES.length, FIELDS.length];
test.afterEach(() => {
  PAGES.length = pages;
  FIELDS.length = fields;
});

// Needs 149/150 (309459ab): 15 pages became 9; needs 192 (ticket 250): the final draft's 16, machines on its own page again.
test('registry_keeps_builtin_order: the nine built-in pages and their fields survive the move, in nav order', () => {
  // Ticket 391: Agents and Accounts became Providers; Orchestration and Advanced moved into Skills & hooks (registered).
  // Ticket 993: Schedules left Settings for its own widget.
  expect(PAGES.slice(0, 13)).toEqual(['general', 'appearance', 'terminal', 'layout', 'alerts', 'keys', 'providers', 'usage', 'git', 'machines', 'browser', 'libraries', 'history']);
  // Since 38: the two Codex reset rows, autoPull, confirmCloseRunning and notifyFocused. Needs 192 (7): the Symbols Nerd Font toggle's field is gone; F5: orchLevel, orchMaxWorkers, orchMaxDepth, orchMerge, orchAutoClose are gone; F7: branchPrefix, worktreeRoot; ticket 608: notifyDefault; ticket 872: scriptWidgets
  expect(FIELDS.length).toBe(45);
  expect(FIELDS[0]).toEqual({ page: 'providers', key: 'usage.codex_resets', at: '[data-setting="usage.codex_resets"]' }); // needs 225
});

test('registers_page_and_fields: a registered page joins PAGES after the built-ins, its fields join FIELDS', () => {
  registerSettingsPage({ id: 'unit-page', title: 'Unit page', fields: [{ key: 'unitField', at: '[data-setting="unitField"]' }], render: () => null });
  expect(PAGES.at(-1)).toBe('unit-page');
  expect(FIELDS.at(-1)).toEqual({ page: 'unit-page', key: 'unitField', at: '[data-setting="unitField"]' });
});

test('refuses_clashes: a repeated page id or field key is an error, nothing half-registered', () => {
  expect(() => registerSettingsPage({ id: 'appearance', title: 'Again', render: () => null })).toThrow(/appearance/);
  const before = [PAGES.length, FIELDS.length];
  expect(() => registerSettingsPage({ id: 'clash-page', title: 'Clash', fields: [{ key: 'density', at: 'x' }], render: () => null })).toThrow(/density/);
  expect([PAGES.length, FIELDS.length]).toEqual(before);
});
