// Ticket 468 (scorecard D6): a button in a settings row or card says the action alone ("Open", "Edit copy"), never the
// row's or card's title again ("Open Widget library" beside the title "Widget library"). Every Settings page and Skills &
// hooks: each visible button's visible text is checked against its row's name and its card's heading. The accessible name
// of an icon-only button (aria-label "Reset Look to defaults") names its target on purpose and is not checked.
// Ticket 554: the walk runs in three states (default, a failed machine, a failed provider), with every closed add form opened
// ("Add profile" under "Browser profiles"), so the buttons of the failed cards ("Copy diagnostics") are checked too.
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { BUILTIN_PAGES } from '../src/features/builtin';
import { agentsToml, ownerOk, tomlEntry } from './acp-fakes';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

/** Every Settings page and Skills & hooks, with each closed fold and add form opened; returns the repeats found. */
async function walk(app: Page) {
  await openWindow(app);
  await openSettings(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  const found: string[] = [];
  // Every page in the nav, as settings-why.spec.ts walkBare does (the in-app browser page is not in BUILTIN_PAGES).
  const ids = await nav.locator('button[data-page]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.page!));
  expect(ids).toEqual(expect.arrayContaining([...BUILTIN_PAGES, 'extensions']));
  for (const id of ids) {
    await nav.locator(`button[data-page="${id}"]`).click();
    await expect(app.locator('.spage h1').first()).toBeVisible();
    await app.waitForTimeout(400); // the page's core reads settle (machine details, probes)
    await app.evaluate(() => document.querySelectorAll('.sbody details').forEach((d) => ((d as HTMLDetailsElement).open = true)));
    // Every closed add form and fold, as settings-why.spec.ts walkBare does; a button inside a form shows only once it is open.
    const closed = app.locator('.sbody [aria-expanded="false"]');
    for (let n = await closed.count(); n > 0; n--) {
      const next = closed.first();
      if (!(await next.isVisible()) || (await next.isDisabled())) break;
      await next.click();
    }
    found.push(
      ...(await app.evaluate((id) => {
        // Ticket 471: "added" is the same word as "add" here ("Add for Nunchiro sessions" under "Added for Nunchiro sessions").
        const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\badded\b/g, 'add');
        const out: string[] = [];
        for (const b of Array.from(document.querySelectorAll<HTMLElement>('.sbody button, .sbody [role="button"], .sbody a.btn'))) {
          const text = norm(b.innerText);
          if (!text || b.getBoundingClientRect().width === 0) continue;
          // "More online themes" loads the next page of the online list; "themes" there is the list, not the Theme row's name.
          if (b.classList.contains('tmore-page')) continue;
          out.push(`seen ${id}: ${text.slice(0, 40)}`);
          // The row's name, and the heading of the card or section the button sits in.
          const titles = [
            b.closest('.srow')?.querySelector('.snm, .slab'),
            b.closest('section')?.querySelector(':scope > header h2, :scope > header h3, :scope > h2, :scope > h3, .shd h2, .shd h3'),
            b.closest('.prv-card, .ext-row, [data-row]')?.querySelector('.prv-name, .ext-name, .snm, h3, h4'),
            // A sub-heading set right above the card (Skills & hooks: "Added for Nunchiro sessions").
            ((c) => (c?.previousElementSibling?.matches('h3, h4') ? c.previousElementSibling : null))(b.closest('.scard')),
          ]
            .filter((t): t is Element => !!t && !t.contains(b) && !b.contains(t)) // a button that wraps its row (the machine card) is the row, not a label
            .map((t) => norm((t as HTMLElement).innerText.split('\n')[0]));
          // Ticket 554: a panel named by aria-label and no heading ("Diagnostics" under a failed machine) is a title too.
          titles.push(norm(b.closest('[role="group"][aria-label]')?.getAttribute('aria-label')));
          for (const title of titles) if (title.length > 2 && text.includes(title)) out.push(`${id}: "${b.innerText.trim()}" repeats "${title}"`);
        }
        return out;
      }, id)),
    );
  }
  // `seen` proves each state put its buttons on screen; a seed that stops rendering must fail here, not pass by looking at nothing.
  const seen = found.filter((f) => f.startsWith('seen ')).map((f) => f.slice(5));
  return { repeats: [...new Set(found.filter((f) => !f.startsWith('seen ')))], seen };
}

test('button_label_not_title: no button on the Settings pages or Skills & hooks repeats its row or card title', async ({ app }) => {
  test.setTimeout(90_000);
  const { repeats, seen } = await walk(app);
  expect(repeats).toEqual([]);
  expect(seen).toContain('inapp-browser: add profile');
});

// Ticket 554: a provider that failed to start and a machine whose channel is down add cards with their own buttons
// ("Copy diagnostics" under "Diagnostics"). The seeds are the ones settings-why.spec.ts uses for why_every_page_failed.
test('button_label_not_title_failed: the same walk with a failed provider and a failed machine', async ({ app, core }) => {
  test.setTimeout(90_000);
  fs.writeFileSync(agentsToml(core), tomlEntry('gone', '/nonexistent/gone'));
  const view = ownerOk(core, { op: 'acp_agent_status', name: 'gone' }).view;
  ownerOk(core, { op: 'acp_agent_grant', name: 'gone', hash: view.hash });
  const machines = [
    { machine: 'down', host: null, user: null, port: null, keys: [], fingerprint: null, channel: { state: 'down', since_ms: 0, error: 'SSH unavailable' } },
    { machine: 'studio', host: 'studio', user: 'me', port: 2222, keys: ['~/.ssh/id_rsa'], fingerprint: null, channel: { state: 'version_mismatch', since_ms: 0, remote_version: '0.7.1', remote_protocol: 1, local_protocol: 2, error: 'version mismatch: remote protocol 1, local protocol 2' } },
  ];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.request?.op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines } } }));
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  const { repeats, seen } = await walk(app);
  expect(repeats).toEqual([]);
  expect(seen).toEqual(expect.arrayContaining(['machines: copy', 'providers: copy diagnostics', 'providers: open logs']));
});
