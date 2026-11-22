// Ticket 329: which title a failed load gets, and which failures retry by themselves.
import { expect, test } from '@playwright/test';
import { causeOf, hostOf, isWeb, retriesItself } from '../src/pane/browser/view/failure';

test('cause_follows_the_code', () => {
  expect([-1004, -1003, -1006, -1001, -1009, -1200].map(causeOf)).toEqual(['refused', 'dns', 'dns', 'timeout', 'offline', 'other']);
});

test('host_falls_back_to_the_text', () => {
  expect(hostOf('http://localhost:3000/a')).toBe('localhost:3000');
  expect(hostOf('localhost:3000')).toBe('localhost:3000');
});

test('only_http_opens_outside', () => {
  expect(['http://a.test/', 'https://a.test/', 'file:///etc/hosts', 'javascript:alert(1)', 'nope'].map(isWeb)).toEqual([true, true, false, false, false]);
});

test('only_a_refused_local_load_of_ours_retries', () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:5173/x', 'http://wt-a.localhost:3000/']) expect(retriesItself('refused', url, url)).toBe(true);
  expect(retriesItself('refused', 'http://localhost:3000/a', 'localhost:3000')).toBe(true); // a bare address is http on loopback
  expect(retriesItself('refused', 'http://localhost:3000/', '')).toBe(false); // the agent's load
  expect(retriesItself('refused', 'http://localhost:3000/path', 'https://example.com/')).toBe(false); // a typed site redirected here
  expect(retriesItself('dns', 'http://localhost:3000/', 'localhost:3000')).toBe(false);
  expect(retriesItself('refused', 'https://example.com/', 'https://example.com/')).toBe(false);
  expect(retriesItself('refused', 'http://localhost.example.com/', 'http://localhost.example.com/')).toBe(false);
  expect(retriesItself('refused', 'localhost:3000', 'localhost:3000')).toBe(false);
});
