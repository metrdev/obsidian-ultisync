/** Loaded only on desktop. Abort on links rather than treating their targets as deleted. */
export async function desktopBoundary(base: string): Promise<(path?: string) => void> {
 const [{lstatSync,readdirSync},paths] = await Promise.all([import('node:fs'),import('node:path')]);
 const root = paths.resolve(base, 'GPT');
 const check = (path: string) => {
  const target = paths.resolve(base, path);
  const rel = paths.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + paths.sep) || paths.resolve(root, rel) !== target) throw new Error('Outside GPT.');
  let current = base;
  const parts = paths.relative(base, target).split(paths.sep);
  for (let i = 0; i < parts.length; i++) {
   current = paths.resolve(current, parts[i]!);
   try {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are forbidden in GPT.');
   } catch (e) {
    if ((e as {code?: string}).code === 'ENOENT') return;
    throw e;
   }
  }
 };
 return (path?: string) => {
  check(path ?? 'GPT');
  if (path) return;
  const scan = (directory: string) => {
   for (const item of readdirSync(directory, {withFileTypes: true})) {
    const target = paths.resolve(directory, item.name);
    if (lstatSync(target).isSymbolicLink()) throw new Error('Symbolic links are forbidden in GPT.');
    if (item.isDirectory()) scan(target);
   }
  };
  scan(root);
 };
}
