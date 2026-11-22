// Needs 117 / ticket 73: which text counts as a claude.ai artifact link. Pure function, no page.
import { expect, test } from '@playwright/test';
import { claudeArtifactLinks } from '../src/chat/claude-link';

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('claudeArtifactLinks: both documented shapes match, query and fragment are dropped, order kept', () => {
  expect(claudeArtifactLinks('Published: https://claude.ai/artifact/abc123XYZ')).toEqual(['https://claude.ai/artifact/abc123XYZ']);
  expect(claudeArtifactLinks(`see https://claude.ai/code/artifact/${UUID.toUpperCase()}.`)).toEqual([`https://claude.ai/code/artifact/${UUID.toUpperCase()}`]);
  expect(claudeArtifactLinks('[page](https://claude.ai/artifact/a_b-c) and <https://claude.ai/artifact/z?x=1#f>')).toEqual([
    'https://claude.ai/artifact/a_b-c',
    'https://claude.ai/artifact/z',
  ]);
  for (const end of [')', ']', '>', '"', "'", ',', '.', ';', ':', '!', '?q=1', '#h', '\n', ' x', '']) {
    expect(claudeArtifactLinks(`https://claude.ai/artifact/id1${end}`)).toEqual(['https://claude.ai/artifact/id1']);
  }
});

test('lookalikes_stay_text: every look-alike yields no link', () => {
  const bad = [
    'https://claude.ai.evil.com/artifact/x',
    'https://claude.ai@evil.com/artifact/x',
    'https://evil.com/claude.ai/artifact/x',
    'http://claude.ai/artifact/x',
    'https://claude.ai:8443/artifact/x',
    'https://user@claude.ai/artifact/x',
    `https://claude.ai/chat/${UUID}`,
    'https://claude.ai/artifact/',
    'https://claude.ai/artifact/x/../../chat/y',
    'https://www.claude.ai/artifact/x',
    'https://claude.ai/code/artifact/not-a-uuid',
    `https://claude.ai/code/artifact/${UUID}x`,
    `https://claude.ai/artifact/${'a'.repeat(65)}`,
    'xhttps://claude.ai/artifact/x',
    'https://CLAUDE.AI/artifact/x',
  ];
  for (const b of bad) expect(claudeArtifactLinks(b), b).toEqual([]);
});

test('claudeArtifactLinks: de-duplicates and caps at five', () => {
  expect(claudeArtifactLinks('https://claude.ai/artifact/a https://claude.ai/artifact/a?x')).toEqual(['https://claude.ai/artifact/a']);
  const six = 'abcdef'.split('').map((c) => `https://claude.ai/artifact/${c}`);
  expect(claudeArtifactLinks(six.join(' '))).toEqual(six.slice(0, 5));
});
