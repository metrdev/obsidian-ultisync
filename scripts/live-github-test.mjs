import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {MockVault,makeApp} from '../tests/mock-vault.ts';
import {DEFAULT_SETTINGS,DEFAULT_STATE} from '../src/types.ts';
const REPO='metrdev/personal-vault-sync-verification';
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const metadata=JSON.parse(gh('repo','view',REPO,'--json','isPrivate,isFork'));
assert.equal(metadata.isPrivate,true);assert.equal(metadata.isFork,false);
let token=gh('auth','token');
let offline=false;
const temp=await mkdtemp(join(tmpdir(),'pvs-live-'));
try {
 const mock=await readFile('tests/obsidian-mock.ts','utf8');
 const source=mock.slice(0,mock.indexOf('export async function requestUrl'))+`
 export async function requestUrl(args) {
  return globalThis.liveRequest(args);
 }`;
 globalThis.liveRequest=async args=>{
  if(offline) throw new Error('Simulated offline');
  assert.ok(args.url.startsWith('https://api.github.com/repos/'+REPO+'/'));
  const response=await fetch(args.url,{method:args.method,headers:args.headers,body:args.body});
  return {status:response.status,text:await response.text(),headers:Object.fromEntries(response.headers)};
 };
 const output=join(temp,'live.cjs');
 await build({stdin:{contents:[
  "export {SyncManager} from './src/sync/SyncManager';",
  "export {scopedApp} from './src/personal/ScopedVault';",
  "export {TFile} from 'obsidian';",
 ].join('\n'),resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'silent',
 plugins:[{name:'live-obsidian',setup(b){
  b.onResolve({filter:/^obsidian$/},()=>({path:'mock',namespace:'live'}));
  b.onLoad({filter:/.*/,namespace:'live'},()=>({contents:source,loader:'ts'}));
 }}]});
 globalThis.window=globalThis;globalThis.document={visibilityState:'visible'};
 const {SyncManager,scopedApp,TFile}=createRequire(import.meta.url)(output);
 const vault=new MockVault(TFile);vault.addFolder('GPT');vault.addFile('Family/private.md','OUTSIDE MUST NOT UPLOAD');
 const app=scopedApp(makeApp(vault),()=>undefined);
 const state=structuredClone(DEFAULT_STATE);state.deviceId='verification';
 const settings={...DEFAULT_SETTINGS,githubOwner:'metrdev',githubRepo:'personal-vault-sync-verification',branch:'main',token};
 const errors=[];
 const manager=new SyncManager(app,settings,{save:async()=>{}},state,(s,d)=>{if(s==='error')errors.push(d);},()=>{});
 manager.debug=()=>{};manager.scheduleDebouncedPush=()=>{};
 try {
  await manager.initialPull();
  assert.ok(state.lastSyncedCommit,'initial pull must succeed');
  const file=vault.addFile('GPT/note.md','local first version');
  await manager.pushEverything();
  const read=()=>JSON.parse(gh('api','repos/'+REPO+'/contents/note.md'));
  let remote=read();
  assert.equal(Buffer.from(remote.content,'base64').toString(),'local first version');
  assert.throws(()=>gh('api','repos/'+REPO+'/contents/Family/private.md'));
  const update=(text)=> {
   const current=read();
   gh('api','--method','PUT','repos/'+REPO+'/contents/note.md','-f','message=verification change',
    '-f','sha='+current.sha,'-f','content='+Buffer.from(text).toString('base64'));
  };
  update('remote second version');
  for(let i=0;i<6 && vault.getText(file)!=='remote second version';i++){
   await manager.pullNow();if(vault.getText(file)!=='remote second version')await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(vault.getText(file),'remote second version');
  vault.setText(file,'local conflicting edit');update('remote conflicting edit');
  for(let i=0;i<6 && !state.conflicts['note.md'];i++){
   await manager.pullNow();if(!state.conflicts['note.md'])await new Promise(r=>setTimeout(r,1000));
  }
  assert.ok(state.conflicts['note.md'],'conflict must be recorded');
  assert.equal(vault.getText(file),'local conflicting edit');
  assert.ok(vault.getFiles().some(f=>f.path.startsWith('GPT/') && vault.getText(f)==='remote conflicting edit'),'remote conflict copy');
  offline=true;await manager.pullNow();
  assert.equal(vault.getText(file),'local conflicting edit');
  console.log(JSON.stringify({repository:REPO,private:true,initialPull:true,scopedPush:true,remotePull:true,conflictPreserved:true,offlinePreserved:true}));
 } finally {manager.destroy();}
} finally {token='';delete globalThis.liveRequest;await rm(temp,{recursive:true,force:true});}
