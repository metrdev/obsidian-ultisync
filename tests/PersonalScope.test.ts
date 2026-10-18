import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { MockVault, makeApp } from './mock-vault.ts';

const dir = await mkdtemp(join(tmpdir(), 'personal-scope-'));
const output = join(dir, 'scope.cjs');
await build({ stdin: { contents: [
 "export { scopedApp, localPath, relativePath } from './src/personal/ScopedVault';",
 "export { DeviceStore } from './src/personal/DeviceStore';",
 "export { TFile } from 'obsidian';",
 "export { ChangeDetector } from './src/sync/ChangeDetector';",
].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
 bundle: true, platform: 'node', format: 'cjs', outfile: output,
 plugins: [{ name: 'mock', setup(b) { b.onResolve({filter: /^obsidian$/}, () =>
 ({path: resolve('tests/obsidian-mock.ts')})); } }] });
const { scopedApp, localPath, relativePath, DeviceStore, TFile, ChangeDetector } = createRequire(import.meta.url)(output);
after(() => rm(dir, {recursive: true, force: true}));
const encode = (s: string) => new TextEncoder().encode(s).buffer;
function fixture() {
 const vault = new MockVault(TFile);
 vault.addFolder('GPT');
 const personal = vault.addFile('GPT/anime.md', 'personal');
 const other = vault.addFile('Family/private.md', 'private');
 const scope = scopedApp(makeApp(vault), () => undefined);
 return {vault, personal, other, scope};
}
describe('GPT boundary', () => {
 it('exposes only GPT files, with repository-relative paths and stable identities', () => {
  const {scope} = fixture();
  assert.deepEqual(scope.vault.getFiles().map(f => f.path), ['anime.md']);
  assert.equal(scope.vault.getAbstractFileByPath('anime.md'), scope.vault.getFiles()[0]);
  assert.ok(scope.vault.getFiles()[0] instanceof TFile);
 });
 it('maps writes, folders, renames and trash into GPT only', async () => {
  const {vault, other, scope} = fixture();
  await scope.vault.createBinary('new.md', encode('new'));
  assert.ok(vault.getAbstractFileByPath('GPT/new.md'));
  const f = scope.vault.getAbstractFileByPath('new.md');
  await scope.vault.rename(f, 'renamed.md');
  assert.equal(f.path, 'renamed.md');
  await scope.fileManager.trashFile(f);
  assert.equal(vault.getAbstractFileByPath('GPT/renamed.md'), null);
  assert.equal(vault.getText(other), 'private');
 });
 it('refuses traversal, absolute, hidden and ambiguous paths before any write', async () => {
  const {scope, vault} = fixture();
  for(const p of ['../private.md','/private.md','C:/private.md','a/../../x','a/./x','a//x','.git/config','a/.hidden.md','.. /outside.md','folder./x','NUL.md','a/note.md ','a\\x','a\u0000x']) {
   assert.throws(() => localPath(p), p);
   await assert.rejects(async () => scope.vault.createBinary(p, encode('bad')), undefined, p);
  }
  assert.equal(vault.pluginWrites, 0);
  assert.equal(relativePath('GPT-other/note.md'), null);
 });
 it('refuses foreign file objects and access to the underlying adapter', async () => {
  const {scope, other} = fixture();
  await assert.rejects(async () => scope.vault.readBinary(other));
  assert.throws(() => scope.vault.adapter);
 });
 it('does not discover newly created notes outside GPT for upload', async () => {
  const {scope, vault} = fixture();
  vault.addFile('new-private-folder/secret.md', 'secret');
  const detector = new ChangeDetector(scope.vault, {ignoredPaths: []});
  const changes = await detector.detectLocalChanges({trackedFiles:{}}, ['.md']);
  assert.deepEqual([...changes.modifiedOrCreated], ['anime.md']);
 });
 it('stops the scan on an unsafe physical scope instead of reporting deletions', () => {
  const {vault} = fixture();
  const scope = scopedApp(makeApp(vault), () => {throw new Error('symlink');});
  assert.throws(() => scope.vault.getFiles(), /symlink/);
 });
});
describe('device-local persistence', () => {
 it('isolates vaults and repositories and commits writes before resolving', async () => {
  const a = new DeviceStore('vault-a', indexedDB);
  const b = new DeviceStore('vault-b', indexedDB);
  await a.put('repo-one', {head:'one'});
  await a.put('repo-two', {head:'two'});
  assert.deepEqual(await a.get('repo-one'), {head:'one'});
  assert.deepEqual(await a.get('repo-two'), {head:'two'});
  assert.equal(await b.get('repo-one'), undefined);
  a.close(); b.close();
 });
 it('fails closed when IndexedDB is absent', async () => {
  const a = new DeviceStore('no-storage', null);
  await assert.rejects(a.get('context'), /IndexedDB/);
 });
});
