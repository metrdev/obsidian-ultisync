import { strict as assert } from 'node:assert';
import {createHash} from 'node:crypto';
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
 "export { SyncManager } from './src/sync/SyncManager';",
 "export { DEFAULT_SETTINGS, DEFAULT_STATE } from './src/types';",
 "export { DeviceStore } from './src/personal/DeviceStore';",
 "export { TFile } from 'obsidian';",
 "export { ChangeDetector } from './src/sync/ChangeDetector';",
].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
 bundle: true, platform: 'node', format: 'cjs', outfile: output,
 plugins: [{ name: 'mock', setup(b) { b.onResolve({filter: /^obsidian$/}, () =>
 ({path: resolve('tests/obsidian-mock.ts')})); } }] });
const { scopedApp, localPath, relativePath, DeviceStore, TFile, ChangeDetector, SyncManager, DEFAULT_SETTINGS, DEFAULT_STATE } = createRequire(import.meta.url)(output);
after(() => rm(dir, {recursive: true, force: true}));
const encode = (s: string) => new TextEncoder().encode(s).buffer;
function fixture() {
 const vault = new MockVault(TFile);
 vault.addFolder('GPT');
 vault.addFolder('FamilyNotes');
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
describe('single shared recipe mapping', () => {
 function recipes() {
  const f=fixture();
  const shared=f.vault.addFile('FamilyNotes/recipes.md','shared recipes');
  const pointer=f.vault.addFile('GPT/recipes.md','[[FamilyNotes/recipes]]');
  const privateFile=f.vault.addFile('FamilyNotes/private.md','family secret');
  return {...f,shared,pointer,privateFile};
 }
 it('exposes exactly the shared recipe and never its GPT pointer or other family notes', () => {
  const {scope,shared}=recipes();
  assert.equal(localPath('recipes.md'),'FamilyNotes/recipes.md');
  assert.equal(relativePath('FamilyNotes/recipes.md'),'recipes.md');
  assert.equal(relativePath('GPT/recipes.md'),null);
  assert.equal(relativePath('FamilyNotes/private.md'),null);
  assert.deepEqual(scope.vault.getFiles().map(f=>f.path),['anime.md','recipes.md']);
  assert.equal(scope.vault.getAbstractFileByPath('recipes.md'),scope.vault.getFiles()[1]);
  assert.equal(scope.vault.getAbstractFileByPath('recipes.md').parent,null);
  assert.equal(shared.path,'FamilyNotes/recipes.md');
 });
 it('writes and trashes only the permitted family file, leaving the pointer and neighbours intact',async()=>{
  const {scope,vault,shared,pointer,privateFile}=recipes();
  const file=scope.vault.getAbstractFileByPath('recipes.md');
  await scope.vault.modifyBinary(file,encode('remote change'));
  assert.equal(vault.getText(shared),'remote change');
  assert.equal(vault.getText(pointer),'[[FamilyNotes/recipes]]');
  await assert.rejects(async()=>scope.vault.readBinary(privateFile),/Foreign/);
  await scope.fileManager.trashFile(file);
  assert.equal(vault.getAbstractFileByPath('FamilyNotes/recipes.md'),null);
  await scope.vault.createBinary('recipes.md',encode('recreated'));
  assert.equal(vault.getText(vault.getAbstractFileByPath('FamilyNotes/recipes.md')),'recreated');
  assert.equal(vault.getText(privateFile),'family secret');
 });
 it('pins the shared path during remote renames and rejects Windows aliases',async()=>{
  const {scope,shared}=recipes();
  await assert.rejects(scope.vault.rename(scope.vault.getAbstractFileByPath('recipes.md'),'elsewhere.md'),/fixed/);
  await assert.rejects(scope.vault.rename(scope.vault.getAbstractFileByPath('anime.md'),'recipes.md'),/fixed/);
  assert.equal(shared.path,'FamilyNotes/recipes.md');
  for(const path of ['Recipes.md','RECIPES.MD','recipes.md/child.md','FamilyNotes/../private.md'])assert.throws(()=>localPath(path));
  await assert.rejects(scope.vault.createFolder('recipes.md'));
 });
 it('detects shared recipe edits while ignoring all other family data',async()=>{
  const {scope}=recipes();
  const detector=new ChangeDetector(scope.vault,{ignoredPaths:[]});
  const changes=await detector.detectLocalChanges({trackedFiles:{}},['.md']);
  assert.deepEqual([...changes.modifiedOrCreated],['anime.md','recipes.md']);
 });
 it('forwards recipe events but ignores the GPT pointer and family neighbours',async()=>{
  const {vault,shared,pointer,privateFile}=recipes();const listeners=new Map();
  vault.on=(name,callback)=>{const ref={name,callback};listeners.set(ref,ref);return ref;};
  vault.offref=ref=>listeners.delete(ref);
  const scope=scopedApp(makeApp(vault),()=>undefined),events=[];
  const emit=(name,...args)=>{for(const ref of listeners.values())if(ref.name===name)ref.callback(...args);};
  const modified=scope.vault.on('modify',file=>events.push(file.path));
  emit('modify',pointer);emit('modify',privateFile);emit('modify',shared);
  assert.deepEqual(events,['recipes.md']);scope.vault.offref(modified);emit('modify',shared);
  assert.deepEqual(events,['recipes.md']);
  scope.vault.on('delete',file=>events.push('delete:'+file.path));
  await vault.rename(shared,'FamilyNotes/renamed.md');emit('rename',shared,'FamilyNotes/recipes.md');
  assert.deepEqual(events,['recipes.md','delete:recipes.md']);
 });
 it('keeps read failures from becoming recipe deletions',async()=>{
  const {vault,scope,shared}=recipes(),read=vault.readBinary.bind(vault);
  vault.readBinary=async file=>{if(file===shared)throw new Error('shared file unavailable');return read(file);};
  const detector=new ChangeDetector(scope.vault,{ignoredPaths:[]});
  await assert.rejects(detector.detectLocalChanges({trackedFiles:{'recipes.md':{localHash:'old',mtime:0,size:0}}},['.md']),/unavailable/);
 });
 it('applies a remote recipe and preserves both versions of a later conflict',async()=>{
  globalThis.window=globalThis;
  const {vault,scope,shared,pointer,privateFile}=recipes();vault.setText(shared,'base');
  const sha=text=>createHash('sha256').update(text).digest('hex');
  const blobSha=text=>createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
  const state=structuredClone(DEFAULT_STATE);state.deviceId='recipe-test';state.lastSyncedCommit='old';
  state.trackedFiles['recipes.md']={localHash:sha('base'),remoteSha:blobSha('base'),mtime:shared.stat.mtime,size:shared.stat.size};
  state.lastSyncedTree={'recipes.md':blobSha('base')};
  const blobs=new Map([['base',blobSha('base')]]);let text='remote first';
  const snapshot=()=>({commitSha:'head',treeSha:'tree',entries:new Map([['recipes.md',{path:'recipes.md',mode:'100644',type:'blob',sha:blobSha(text),size:Buffer.byteLength(text)}]])});
  const github={getCommit:async()=>({sha:'head',tree:{sha:'tree'}}),readTreeSnapshot:async()=>snapshot(),getBlob:async id=>{
   const content=[...blobs.entries()].find(([,hash])=>hash===id)?.[0];if(content===undefined)throw new Error('Unknown test blob');
   return {sha:id,content:Buffer.from(content).toString('base64'),encoding:'base64',size:Buffer.byteLength(content)};
  }};
  const manager=new SyncManager(scope,{...DEFAULT_SETTINGS,syncEnabled:true},{save:async()=>{}},state,()=>{},()=>{});
  manager.debug=()=>{};manager.scheduleDebouncedPush=()=>{};manager.getClient=()=>github;
  try{
   blobs.set(text,blobSha(text));await manager.reconcileRemoteAndLocal('head',github,true,'ahead');
   assert.equal(vault.getText(shared),'remote first');assert.equal(vault.getText(pointer),'[[FamilyNotes/recipes]]');
   vault.setText(shared,'local conflict');text='remote conflict';blobs.set(text,blobSha(text));
   await manager.reconcileRemoteAndLocal('next',github,true,'ahead');
   assert.ok(state.conflicts['recipes.md']);assert.equal(vault.getText(shared),'local conflict');
   assert.ok(vault.getFiles().some(file=>file.path.startsWith('GPT/recipes (conflict')&&vault.getText(file)==='remote conflict'));
   assert.equal(vault.getText(privateFile),'family secret');
  }finally{manager.destroy();}
 });
 it('fails closed when the shared parent is unavailable instead of reporting deletions',()=>{
  const vault=new MockVault(TFile);vault.addFolder('GPT');
  const scope=scopedApp(makeApp(vault),()=>undefined);
  assert.throws(()=>scope.vault.getFiles(),/FamilyNotes/);
  assert.throws(()=>scope.vault.getAbstractFileByPath('recipes.md'),/FamilyNotes/);
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
