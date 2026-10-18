
export function excludedFromBackup(path: string, configDir: string): boolean {
 const p = path.replace(/\\/g, '/');
 return p.split('/').some(part => ['.git','.trash','node_modules','.cache'].includes(part)) ||
  /(^|\/)(\.env(?:\..*)?|credentials[^/]*|secrets?[^/]*|id_rsa|id_ed25519)$/i.test(p) ||
  /\.(tmp|swp|bak|key|pfx|p12)$/i.test(p) ||
  p === configDir+'/workspace.json' || p === configDir+'/workspace-mobile.json' ||
  [configDir+'/plugins/personal-vault-sync/data.json',configDir+'/plugins/ultisync/data.json'].includes(p);
}
export function containsCredential(text: string): boolean {
 return /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|"(?:access_token|refresh_token)"\s*:\s*"[^"]{12,}")/.test(text);
}
export function repositoryIdentity(url: string): string {
 return url.trim().replace(/^git@github\.com:/,'').replace(/^https:\/\/github\.com\//,'').replace(/\.git$/,'').toLowerCase();
}
export interface BackupResult { changed: boolean; commit: string; }
export class NativeBackup {
 private running = false;
 constructor(private root: string, private expectedRepo: string, private configDir: string) {}
 async run(): Promise<BackupResult> {
  if (this.running) throw new Error('A backup is already running.');
  this.running = true;
  const [{execFile},{readFile,open,rename,unlink,mkdtemp,rm,lstat},path,{tmpdir},{default:process},{Buffer}] = await Promise.all([
   import('node:child_process'),import('node:fs/promises'),import('node:path'),import('node:os'),import('node:process'),import('node:buffer')]);
  let temp = '', lock: Awaited<ReturnType<typeof open>> | undefined, lockPath = '';
  const env = {...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'};
  const git = (args: string[], input?: string | Uint8Array, extra = {}): Promise<string> => new Promise((res, rej) => {
   const child = execFile('git', args, {cwd:this.root, env:{...env,...extra}, maxBuffer:16*1024*1024, windowsHide:true, timeout:120000},
    (error, stdout) => error ? rej(new Error('Git backup failed at ' + args[0] + '. Check repository access and history.')) : res(stdout));
   child.stdin?.on('error', () => undefined);
   child.stdin?.end(input);
  });
  try {
   if (repositoryIdentity(await git(['remote','get-url','origin'])) !== repositoryIdentity(this.expectedRepo)) throw new Error('Unexpected backup repository.');
   const branch = (await git(['symbolic-ref','--short','HEAD'])).trim();
   if (branch !== 'main' && branch !== 'master') throw new Error('Backup requires the existing main or master branch.');
   await git(['diff','--cached','--quiet']);
   await git(['fetch','origin',branch]);
   await git(['merge-base','--is-ancestor','refs/remotes/origin/'+branch,'HEAD']);
   const previous = (await git(['rev-parse','HEAD'])).trim();
   const gitDir = path.resolve(this.root, (await git(['rev-parse','--git-dir'])).trim());
   const candidateLock = path.join(gitDir,'index.lock');
   lock = await open(candidateLock,'wx');
   lockPath = candidateLock;
   // With the real index locked, other Git writers cannot change its staging.
   await git(['diff','--cached','--quiet']);
   temp = await mkdtemp(path.join(tmpdir(),'personal-backup-'));
   const index = path.join(temp,'index');
   const isolated = {GIT_INDEX_FILE:index};
   await git(['read-tree', 'HEAD'], undefined, isolated);
   const paths = [...new Set((await git(['ls-files','-co','--exclude-standard','-z'])).split('\0').filter(Boolean))];
   const allowed = paths.filter(p => !excludedFromBackup(p,this.configDir));
   const excluded = paths.filter(p => excludedFromBackup(p,this.configDir));
   if (excluded.length) await git(['update-index','--force-remove','-z','--stdin'], Buffer.from(excluded.join('\0')+'\0'), isolated);
   if (!allowed.some(p => p.startsWith('GPT/'))) throw new Error('GPT is absent; refusing an incomplete backup.');
   let missing = 0;
   for (const p of allowed) {
    try {
     const stat = await lstat(path.resolve(this.root,p));
     if (stat.isSymbolicLink()) throw new Error('Backup contains a symbolic link. Migrate it first.');
     if (stat.isFile() && stat.size < 2*1024*1024 && /\.(md|txt|json|yaml|yml|toml|ini|conf)$/i.test(p)) {
      if (containsCredential(await readFile(path.resolve(this.root,p),'utf8'))) throw new Error('Credential detected in '+p+'; exclude the affected file before backup.');
     }
    } catch(e) { if ((e as {code?: string}).code === 'ENOENT') missing++; else throw e; }
   }
   if (missing > 3 && missing > allowed.length/5) throw new Error('Too many files are missing; refusing a partial backup.');
   if (allowed.length) await git(['-c','core.symlinks=true','add','-A','--pathspec-from-file=-','--pathspec-file-nul'], Buffer.from(allowed.join('\0')+'\0'), isolated);
   if ((await git(['ls-files','--stage','-z'],undefined,isolated)).split('\0').some(record => record.startsWith('120000 '))) {
    throw new Error('Snapshot still contains a symbolic link; refusing publication.');
   }
   const tree = (await git(['write-tree'], undefined, isolated)).trim();
   const previousTree = (await git(['rev-parse','HEAD^{tree}'])).trim();
   let commit = previous;
   if (tree !== previousTree) {
    commit = (await git(['-c','user.name=metrdev','-c','user.email=112458138+metrdev@users.noreply.github.com',
     'commit-tree',tree,'-p',previous], 'vault backup: '+new Date().toISOString()+'\n', isolated)).trim();
    await lock.writeFile(await readFile(index));
    await lock.sync();
    await git(['update-ref','refs/heads/'+branch,commit,previous]);
    await lock.close(); lock = undefined;
    await rename(lockPath,path.join(gitDir,'index')); lockPath = '';
   }
   // Also publishes an earlier local backup whose push failed while offline.
   await git(['push','origin','HEAD:refs/heads/'+branch]);
   return {changed:commit !== previous,commit};
  } finally {
   await lock?.close();
   if (lockPath) await unlink(lockPath).catch(() => undefined);
   if (temp) await rm(temp,{recursive:true,force:true});
   this.running = false;
  }
 }
}
