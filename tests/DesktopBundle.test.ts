import {strict as assert} from 'node:assert';
import {it} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {indexedDB} from 'fake-indexeddb';
const nativeRequire=createRequire(import.meta.url);
async function runtime(desktop=true){
 const code=await readFile('main.js','utf8'),loaded=[],dynamic=[],notices=[],gitCalls=[];
 class Stub{
  app;manifest={id:'personal-vault-sync',version:'1.1.2'};tabs=[];
  constructor(app){this.app=app;}
  getSettingDefinitions(){return [];}
  addSettingTab(tab){this.tabs.push(tab);}
  addCommand(){}
  registerInterval(id){clearInterval(id);}
 }
 class Notice{constructor(message){notices.push(message);}}
 const obsidian=new Proxy({Platform:{isDesktopApp:desktop,isMobile:!desktop},Notice},{get(target,key){return key in target?Reflect.get(target,key):Stub;}});
 const require=id=>{
  loaded.push(id);if(id==='obsidian')return obsidian;
  if(!desktop)throw new Error('Native import on mobile: '+id);
  if(id==='node:child_process')return {execFile:(command,args,options,callback)=>{
   gitCalls.push({command,args});queueMicrotask(()=>callback(new Error('Stop before actual Git'),'',''));return {stdin:{on(){},end(){}}};
  }};
  return nativeRequire(id);
 };
 const context={module:{exports:{}},exports:{},indexedDB,structuredClone,console,queueMicrotask,window:{setInterval,clearInterval},require};
 runInNewContext(code,context,{importModuleDynamically:async specifier=>{dynamic.push(specifier);throw new Error('Failed to fetch dynamically imported module: '+specifier);}});
 const Plugin=context.module.exports.default;
 // Deliberately missing SecretStorage: execution must get past desktop module loading.
 const app={vault:{configDir:'.obsidian',adapter:{getResourcePath:()=> 'desktop-test-'+Math.random(),getBasePath:()=>process.cwd()}},workspace:{onLayoutReady(){}}};
 const plugin=new Plugin(app);await plugin.onload();
 return {plugin,loaded,dynamic,notices,gitCalls};
}
it('loads desktop builtins through the CommonJS loader, without browser module fetches',async()=>{
 const {plugin,loaded,dynamic,notices}=await runtime();
 try{assert.deepEqual(dynamic,[]);assert.ok(loaded.includes('node:fs'));assert.ok(loaded.includes('node:path'));
 assert.ok(notices.some(message=>message.includes('SecretStorage is unavailable')));}
 finally{plugin.onunload();}
});
it('loads the desktop backup dependencies and reaches Git without a browser import',async()=>{
 const {plugin,dynamic,gitCalls}=await runtime();
 try{await plugin.runBackup(true);assert.deepEqual(dynamic,[]);assert.equal(gitCalls.length,1);assert.equal(gitCalls[0].args[0],'remote');}
 finally{plugin.onunload();}
});
it('renders exactly one backup section when context setup fails',async()=>{
 const {plugin}=await runtime(false);let count=0;plugin.backupSettings=()=>{count++;};
 try{for(const tab of plugin.tabs)for(const definition of tab.getSettingDefinitions())definition.render?.({setDesc(){},settingEl:{}});assert.equal(count,1);}
 finally{plugin.onunload();}
});
