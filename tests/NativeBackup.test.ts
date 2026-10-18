import {strict as assert} from 'node:assert';
import {after, describe, it} from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, mkdir, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const temp=await mkdtemp(join(tmpdir(),'personal-backup-tests-'));
const bundle=join(temp,'backup.cjs');
await build({entryPoints:['src/personal/NativeBackup.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent'});
const {NativeBackup,excludedFromBackup,containsCredential}=createRequire(import.meta.url)(bundle);
after(()=>rm(temp,{recursive:true,force:true}));
let sequence=0;
async function fixture() {
 const root=join(temp,'case-'+sequence++), repo=join(root,'vault'), remote=join(root,'remote.git');
 await mkdir(repo,{recursive:true});
 const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 execFileSync('git',['init','--bare',remote],{stdio:'pipe'});
 git('init','-b','main');
 git('config','user.name','Backup Test'); git('config','user.email','test@example.invalid');
 await mkdir(join(repo,'GPT')); await writeFile(join(repo,'GPT','note.md'),'base');
 git('add','.');git('commit','-m','initial');git('remote','add','origin',remote);git('push','-u','origin','main');
 return {repo,remote,git,backup:new NativeBackup(repo,remote,'.obsidian')};
}
describe('desktop backup',()=>{
 it('preserves a pre-existing index lock',async()=>{
  const {repo,backup}=await fixture();
  const lock=join(repo,'.git','index.lock');
  await writeFile(lock,'someone else');
  await assert.rejects(backup.run());
  assert.equal(await readFile(lock,'utf8'),'someone else');
 });
 it('backs up GPT, skips credentials and temporary files, and creates no empty commit',async()=>{
  const {repo,git,backup}=await fixture();
  await writeFile(join(repo,'GPT','note.md'),'changed');
  await writeFile(join(repo,'.env'),'TOKEN=private');
  await writeFile(join(repo,'new.md'),'normal note');
  const first=await backup.run();
  assert.equal(first.changed,true);
  assert.equal(git('show','HEAD:GPT/note.md'),'changed');
  assert.equal(git('ls-files','.env'),'');
  assert.equal(git('diff','--cached','--name-only'),'');
  assert.equal((await backup.run()).changed,false);
  assert.equal(git('rev-parse','HEAD'),first.commit);
 });
 it('records former Windows symlinks as ordinary files after migration',async()=>{
  const {repo,git,backup}=await fixture();
  git('config','core.symlinks','false');
  const blob=git('hash-object','-w','GPT/note.md');
  git('update-index','--cacheinfo','120000,'+blob+',GPT/note.md');
  git('commit','-m','legacy link');git('push');
  await writeFile(join(repo,'GPT','note.md'),'ordinary migrated content');
  await backup.run();
  assert.match(git('ls-tree','HEAD','GPT/note.md'),/^100644 blob /);
  assert.equal(git('show','HEAD:GPT/note.md'),'ordinary migrated content');
 });
 it('keeps existing staged work untouched',async()=>{
  const {repo,git,backup}=await fixture();
  await writeFile(join(repo,'GPT','note.md'),'staged');
  git('add','GPT/note.md');
  const before=git('diff','--cached');
  await assert.rejects(backup.run());
  assert.equal(git('diff','--cached'),before);
 });
 it('stops when the remote is ahead without applying its content locally',async()=>{
  const {repo,remote,git,backup}=await fixture();
  const peer=join(temp,'peer-'+sequence++);
  execFileSync('git',['clone','-b','main',remote,peer],{stdio:'pipe'});
  execFileSync('git',['-C',peer,'config','user.name','Peer']);
  execFileSync('git',['-C',peer,'config','user.email','peer@example.invalid']);
  await writeFile(join(peer,'GPT','note.md'),'remote change');
  execFileSync('git',['-C',peer,'commit','-am','peer'],{stdio:'pipe'});
  execFileSync('git',['-C',peer,'push'],{stdio:'pipe'});
  const before=git('rev-parse','HEAD');
  await assert.rejects(backup.run());
  assert.equal(git('rev-parse','HEAD'),before);
  assert.equal(await readFile(join(repo,'GPT','note.md'),'utf8'),'base');
 });
 it('does not publish a newly discovered token',async()=>{
  const {repo,git,backup}=await fixture();
  await writeFile(join(repo,'token.md'),'ghp_'+'x'.repeat(36));
  await assert.rejects(backup.run(),/Credential/);
  assert.equal(git('ls-files','token.md'),'');
 });
 it('filters paths without excluding ordinary personal notes',()=>{
  for(const path of ['.git/config','.trash/note.md','.env','.obsidian/plugins/personal-vault-sync/data.json','a/secrets.json','temp.tmp'])
   assert.equal(excludedFromBackup(path,'.obsidian'),true,path);
  assert.equal(excludedFromBackup('GPT/recipes.md','.obsidian'),false);
  assert.equal(containsCredential('ordinary note'),false);
 });
});
