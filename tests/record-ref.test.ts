import { expect, test } from 'bun:test';
import { parseRecordRef } from '../src/ui/record-ref.ts';

test('refs written by the collector, git hook and proposals parse into actionable targets', () => {
  expect(parseRecordRef('dsh://session-8e69192a-918b#27')).toEqual({ kind: 'dsh', sessionId: 'session-8e69192a-918b', turn: 27 });
  expect(parseRecordRef('dsh://bdc0bf64-0a0b-48b0')).toEqual({ kind: 'dsh', sessionId: 'bdc0bf64-0a0b-48b0' });
  expect(parseRecordRef('git:///Users/ghost/MySpace@94b8357c3580')).toEqual({ kind: 'git', repo: '/Users/ghost/MySpace', sha: '94b8357c3580' });
  expect(parseRecordRef('proposal://p-20261010f81b66')).toEqual({ kind: 'proposal', id: 'p-20261010f81b66' });
  expect(parseRecordRef('/tmp/t.jsonl')).toEqual({ kind: 'other', text: '/tmp/t.jsonl' });
  expect(parseRecordRef('dsh://bad id/../x')).toEqual({ kind: 'other', text: 'dsh://bad id/../x' });
  expect(parseRecordRef(undefined)).toBeUndefined();
});
