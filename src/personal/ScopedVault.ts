import type { App, EventRef, TAbstractFile, Vault } from 'obsidian';

const ROOT = 'GPT';
export const SHARED_RECIPE = 'FamilyNotes/recipes.md';
const RECIPE_PATH = 'recipes.md';
/** A repository path never has an absolute, hidden, parent, or ambiguous component. */
export function localPath(path: string): string {
 // eslint-disable-next-line no-control-regex -- Reject control characters at the path boundary.
 if (!path || /[\\\\:\x00-\x1f]/.test(path) ||
  path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[<>"|?*]/.test(p))) {
  throw new Error('Unsafe context path.');
 }
 if (path.split('/')[0]!.toLowerCase() === RECIPE_PATH && path !== RECIPE_PATH) throw new Error('Shared recipe path is fixed.');
 return path === RECIPE_PATH ? SHARED_RECIPE : ROOT + '/' + path;
}
export function relativePath(path: string): string | null {
 if (path === SHARED_RECIPE) return RECIPE_PATH;
 if (!path.startsWith(ROOT + '/')) return null;
 const relative = path.slice(ROOT.length + 1);
 try { if (localPath(relative) !== path) return null; return relative; } catch { return null; }
}
export type ScopeGuard = (localPath?: string) => void;

/** Only GPT files and the one fixed shared recipe are forwarded to the engine. */
export function scopedApp(app: App, guard: ScopeGuard): App {
 const real = app.vault;
 const wrapped = new WeakMap<TAbstractFile, TAbstractFile>();
 const originals = new WeakMap<TAbstractFile, TAbstractFile>();
 let vault: Vault;
 function wrap(file: TAbstractFile, fixedPath?: string): TAbstractFile {
  if (!fixedPath && wrapped.has(file)) return wrapped.get(file)!;
  const result = new Proxy(file, { get(target, property) {
   if (property === 'path') {
    if (fixedPath !== undefined) return fixedPath;
    if (target.path === ROOT) return '';
    const p = relativePath(target.path);
    if (p === null) throw new Error('File left the permitted context scope.');
    return p;
   }
   if (property === 'vault') return vault;
   if (property === 'parent') return target.path === ROOT ? null :
    target.parent && (target.parent.path === ROOT || relativePath(target.parent.path) !== null) ? wrap(target.parent) : null;
   if (property === 'children') return (Reflect.get(target, property) as TAbstractFile[]).filter(f => relativePath(f.path) !== null).map(f => wrap(f));
   const value: unknown = Reflect.get(target, property, target); return value;
  }});
  if (fixedPath === undefined) wrapped.set(file, result);
  originals.set(result, file);
  return result;
 }
 function sharedParent(): void {
  if (!real.getAbstractFileByPath('FamilyNotes')) throw new Error('FamilyNotes folder is unavailable; context scan stopped.');
 }
 function unwrap(file: TAbstractFile): TAbstractFile {
  const original = originals.get(file);
  if (!original || relativePath(original.path) === null) throw new Error('Foreign file object.');
  if (original.path === SHARED_RECIPE) sharedParent();
  guard(original.path);
  return original;
 }
 const methods: Record<string, unknown> = {
  getFiles: (() => {
   guard(); sharedParent();
   return real.getFiles().filter(f => relativePath(f.path) !== null).map(f => wrap(f));
  }),
  getAbstractFileByPath: ((path: string) => {
   const local = localPath(path);
   if (local === SHARED_RECIPE) sharedParent();
   guard(local);
   const file = real.getAbstractFileByPath(local);
   return file ? wrap(file) : null;
  }),
  readBinary: ((file: TAbstractFile) => real.readBinary(unwrap(file) as Parameters<Vault['readBinary']>[0])),
  read: ((file: TAbstractFile) => real.read(unwrap(file) as Parameters<Vault['read']>[0])),
  cachedRead: ((file: TAbstractFile) => real.cachedRead(unwrap(file) as Parameters<Vault['cachedRead']>[0])),
  process: ((file: TAbstractFile, fn: (text: string) => string) => real.process(unwrap(file) as Parameters<Vault['process']>[0], fn)),
  modifyBinary: ((file: TAbstractFile, bytes: ArrayBuffer) => real.modifyBinary(unwrap(file) as Parameters<Vault['modifyBinary']>[0], bytes)),
  createBinary: (async (path: string, bytes: ArrayBuffer) => {
   const local = localPath(path);
   if (local === SHARED_RECIPE) sharedParent();
   guard(local);
   return wrap(await real.createBinary(local, bytes));
  }),
  createFolder: (async (path: string) => {
   if (path === RECIPE_PATH) throw new Error('The shared recipe is a file.');
   const local = localPath(path);
   if (local === SHARED_RECIPE) sharedParent();
   guard(local);
   return wrap(await real.createFolder(local));
  }),
  rename: (async (file: TAbstractFile, path: string) => {
   if (file.path === RECIPE_PATH || path === RECIPE_PATH) throw new Error('Shared recipe path is fixed.');
   const local = localPath(path);
   if (local === SHARED_RECIPE) sharedParent();
   guard(local);
   await real.rename(unwrap(file), local);
  }),
  getName: (() => real.getName() + '/personal context'),
  on: ((name: string, callback: (...args: unknown[]) => void) => {
   const refs: EventRef[] = [];
   const events = real as unknown as {on(name: string, cb: (file: TAbstractFile, old?: string) => void): EventRef};
   if (name !== 'rename') refs.push(events.on(name, file => {
    if (relativePath(file.path) !== null) callback(wrap(file));
   }));
   refs.push(events.on('rename', (file, old = '') => {
    const from = relativePath(old), to = relativePath(file.path);
    if (name === 'rename' && from !== null && to !== null) callback(wrap(file), from);
    if (name === 'create' && from === null && to !== null) callback(wrap(file));
    if (name === 'delete' && from !== null && to === null) callback(wrap(file, from));
   }));
   return { e: {offref: () => refs.forEach(ref => real.offref(ref))} } as unknown as EventRef;
  }),
  offref: ((ref: EventRef) => (ref as unknown as {e:{offref(ref:EventRef):void}}).e.offref(ref)),
 };
 vault = new Proxy(real, {get(_target, property) {
  if (property === 'configDir') return real.configDir;
  if (typeof property === 'string' && property in methods) return methods[property];
  throw new Error('Unscoped vault access is forbidden: ' + String(property));
 }});
 const manager = new Proxy(app.fileManager, {get(_target, property) {
  if (property === 'trashFile') return (file: TAbstractFile) => app.fileManager.trashFile(unwrap(file));
  throw new Error('Unscoped file manager access is forbidden.');
 }});
 return new Proxy(app, {get(target, property) {
  if (property === 'vault') return vault;
  if (property === 'fileManager') return manager;
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === 'function' ? (...args: unknown[]) => {const result: unknown = Reflect.apply(value,target,args); return result;} : value;
 }});
}
