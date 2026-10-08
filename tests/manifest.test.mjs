import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('manifest contains loadable V14 assets and matches module ID',()=>{
  const m=JSON.parse(readFileSync(resolve(root,'module.json'),'utf8'));
  assert.equal(m.id,'foundry-watch-room');
  assert.equal(m.compatibility.minimum,'14.367');
  assert.equal(m.compatibility.verified,'14.368');
  for(const relative of [...m.esmodules,...m.styles]) assert.ok(existsSync(resolve(root,relative)),`Missing ${relative}`);
  assert.equal(m.socket,true);
});
