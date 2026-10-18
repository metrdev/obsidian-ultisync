import {strict as assert} from 'node:assert';
import {it,after} from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const temp=await mkdtemp(join(tmpdir(),'personal-boundary-'));
after(()=>rm(temp,{recursive:true,force:true}));
const output=join(temp,'boundary.cjs');
await build({entryPoints:['src/personal/DesktopBoundary.ts'],bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'silent'});
const {desktopBoundary}=createRequire(import.meta.url)(output);
it('blocks a real directory junction before scanning or reading outside GPT',async()=>{
 const vault=join(temp,'vault'),outside=join(temp,'private');
 await mkdir(join(vault,'GPT'),{recursive:true}); await mkdir(outside);
 await writeFile(join(outside,'secret.md'),'private');
 const guard=await desktopBoundary(vault);
 guard();
 await symlink(outside,join(vault,'GPT','linked'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>guard(),/Symbolic links/);
 assert.throws(()=>guard('GPT/linked/secret.md'),/Symbolic links/);
 assert.throws(()=>guard('GPT/../private.md'),/Outside/);
});
it('does not treat an unavailable GPT folder as an empty safe scan',async()=>{
 const guard=await desktopBoundary(join(temp,'missing'));
 assert.throws(()=>guard());
});
