// Ticket 1130 B-L4 (C6, owner Q2 yes 11-25; mockup docs/design/first-use-b-1130/mockup.html #c6): which pasted composer
// text gets the "Add MCP server" offer row. Only one stdio `claude mcp add NAME -- COMMAND` line does; everything else
// stays an ordinary prompt with no offer. The words come from the same parser Settings > Skills & hooks uses.
import { expect, test } from '@playwright/test';
import { composerOffer, withoutEnvValues } from '../src/features/pasted-server';

test('offer_for_one_claude_mcp_add_line: the name and the command Add sends, env values left out', () => {
  expect(composerOffer('claude mcp add github -- npx -y @modelcontextprotocol/server-github')).toEqual({ line: 'claude mcp add github -- npx -y @modelcontextprotocol/server-github', name: 'github', command: ['npx', '-y', '@modelcontextprotocol/server-github'], dropped: [] });
  expect(composerOffer('  claude mcp add -s user x -- /bin/echo hi\n')).toMatchObject({ line: 'claude mcp add -s user x -- /bin/echo hi', name: 'x', command: ['/bin/echo', 'hi'] });
  expect(composerOffer('/usr/local/bin/claude mcp add x -- /bin/echo hi')).toMatchObject({ name: 'x', command: ['/bin/echo', 'hi'] });
  expect(composerOffer('claude mcp add srv -e API_KEY=s3cret -- run')).toEqual({ line: 'claude mcp add srv -e API_KEY=s3cret -- run', name: 'srv', command: ['run'], dropped: ['API_KEY'] });
});

test('no_offer_for_other_lines: remote adds, other claude or codex lines, bare commands, prose and broken lines', () => {
  for (const text of [
    'claude mcp add --transport http notion https://mcp.notion.com/mcp',
    'claude mcp add -t sse x https://example.com/sse',
    'codex mcp add docs -- npx docs-mcp',
    'claude mcp list',
    'claude mcp add-json x {}',
    'claude --help',
    'claude mcp add',
    'claude mcp add x',
    'npx -y @modelcontextprotocol/server-github',
    'please run claude mcp add x -- /bin/echo hi for me',
    'claude mcp add x -- /bin/echo hi\nclaude mcp add y -- /bin/echo hi',
    "claude mcp add x -- '/bin/echo hi",
    'claude mcp add x -- /bin/echo "\u0007"',
    '',
  ])
    expect(composerOffer(text), JSON.stringify(text)).toBeNull();
});

test('stored_drafts_keep_no_env_values: an offered line with -e values is stored as the line the add saves (round 2)', () => {
  expect(withoutEnvValues('look:\nclaude mcp add srv -e API_KEY=s3cret --env=TOKEN=t0k -- /bin/echo hi\nthanks')).toBe('look:\nclaude mcp add srv -- /bin/echo hi\nthanks');
  for (const text of ['claude mcp add x -- /bin/echo hi', 'claude mcp add --transport http notion https://mcp.notion.com/mcp', 'API_KEY=1 make', '']) expect(withoutEnvValues(text)).toBe(text);
});
