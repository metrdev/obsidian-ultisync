import {strict as assert} from 'node:assert';
import {it} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {indexedDB} from 'fake-indexeddb';
async function mobile() {
 const code=await readFile('main.js','utf8');
 class Stub {
  app:unknown; manifest={id:'personal-vault-sync',version:'1.1.1'};
  constructor(app:unknown){this.app=app;}
  getSettingDefinitions(){return [];}
  addSettingTab(){}
  addCommand(){}
 }
 const obsidian=new Proxy({Platform:{isDesktopApp:false,isMobile:true}}, {get(target,key) {
  return key in target ? Reflect.get(target,key) : Stub;
 }});
 const loaded:string[]=[];
 const context={module:{exports:{}},exports:{},indexedDB,structuredClone,console,
  require:(id:string)=>{
   loaded.push(id);
   if(id==='obsidian') return obsidian;
   throw new Error('Native module imported on mobile: '+id);
  }};
 runInNewContext(code,context);
 return {Plugin:(context.module.exports as {default:new(app:unknown)=>any}).default,loaded};
}
it('loads the production bundle on mobile without importing any Node module',async()=>{
 const {Plugin,loaded}=await mobile();
 assert.equal(typeof Plugin,'function');
 assert.ok(loaded.length>0);assert.ok(loaded.every(x=>x==='obsidian'));
});
it('refuses mobile backup even with a copied enabled flag and a manual command',async()=>{
 const {Plugin,loaded}=await mobile();
 const app={vault:{configDir:'.obsidian',adapter:{getResourcePath:()=> 'mobile-test-'+Math.random(),
  getBasePath:()=>{throw new Error('Desktop path requested on mobile');}}}};
 const plugin=new Plugin(app);
 await plugin.onload();
 plugin.backup={enabled:true,lastSuccess:null};
 await plugin.runBackup(true);
 assert.ok(loaded.every(x=>x==='obsidian'));
 plugin.onunload();
});
