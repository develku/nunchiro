// Ticket 1123 T10 review round 1: what a pasted line saves as one of Nunchiro's own MCP servers (features/pasted-server.ts).
// A line is only read here; the core gets the command Add sends, so these cases are the whole of what can reach its file.
import { expect, test } from '@playwright/test';
import { pastedServer } from '../src/features/pasted-server';

const read = (line: string) => pastedServer(line.split(' '));

test('claude_add_options_anywhere_before_dash: -e after NAME is an option, its value never reaches the command', () => {
  expect(read('claude mcp add my-server -e API_KEY=s3cret -- /path/to/server')).toEqual({ name: 'my-server', command: ['/path/to/server'], dropped: ['API_KEY'] });
  expect(read('claude mcp add -e A=1 B=2 -s user srv -- npx -y pkg')).toEqual({ name: 'srv', command: ['npx', '-y', 'pkg'], dropped: ['A', 'B'] });
  expect(read('claude mcp add --env=TOKEN=x --scope=project srv -- run')).toEqual({ name: 'srv', command: ['run'], dropped: ['TOKEN'] });
  expect(read('claude mcp add srv npx pkg')).toEqual({ name: 'srv', command: ['npx', 'pkg'], dropped: [] });
  expect(read('/usr/local/bin/claude mcp add x -- /bin/echo hi')).toEqual({ name: 'x', command: ['/bin/echo', 'hi'], dropped: [] });
  for (const line of ['claude mcp add my-server -e API_KEY=s3cret -- /path/to/server', 'claude mcp add -e A=1 B=2 srv -- run']) expect(read(line).command.join(' ')).not.toMatch(/=|^-/);
});

test('agent_cli_lines_are_refused: any other claude or codex line would make the agent CLI itself the server', () => {
  for (const line of ['codex mcp add docs -- npx docs-mcp', 'claude mcp add-json x {}', 'claude --help', '/usr/local/bin/codex mcp add a -- b', 'claude mcp list'])
    expect(read(line), line).toMatchObject({ command: [], refused: 'agent' });
});

test('remote_adds_are_refused: an http or sse transport has no command to run', () => {
  expect(read('claude mcp add --transport http notion https://mcp.notion.com/mcp')).toMatchObject({ command: [], refused: 'remote' });
  expect(read('claude mcp add -t sse x https://example.com/sse')).toMatchObject({ command: [], refused: 'remote' });
  expect(read('claude mcp add -t stdio x -- run').refused).toBeUndefined();
});

test('package_commands_are_named_from_the_package: the command stays as pasted', () => {
  expect(read('npx -y @modelcontextprotocol/server-github')).toEqual({ name: 'github', command: ['npx', '-y', '@modelcontextprotocol/server-github'], dropped: [] });
  expect(read('npx @playwright/mcp@latest').name).toBe('playwright');
  expect(read('uvx mcp-server-fetch').name).toBe('fetch');
  expect(read('/opt/tools/files-mcp --root /tmp').name).toBe('files');
});
