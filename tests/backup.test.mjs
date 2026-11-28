// Settings backup: everything under trilens: except the password and GitHub token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, restore, FORMAT } from '../assets/js/lib/backup.js';

function mem(init = {}) {
  const m = new Map(Object.entries(init));
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('backup keeps settings, leaves out secrets and other sites, and restores', () => {
  const a = mem({ 'trilens:chart:workspace': '{"a":1}', 'trilens:techpass': '"secret"', 'trilens:gh_token': '"ghp_x"', 'trilens:gist_id': '"1"', 'other:thing': '1' });
  const b = collect(a);
  assert.equal(b.format, FORMAT);
  assert.deepEqual(Object.keys(b.items), ['chart:workspace']);
  const c = mem();
  assert.equal(restore(JSON.parse(JSON.stringify({ ...b, items: { ...b.items, techpass: '"x"' } })), c), 1);
  assert.equal(c.getItem('trilens:chart:workspace'), '{"a":1}');
  assert.equal(c.getItem('trilens:techpass'), null, 'a password in a file is never written');
  assert.throws(() => restore({ hello: 1 }, c), /not a Trilens/);
});
