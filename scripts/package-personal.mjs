import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='dist/personal-vault-sync';
await mkdir(root,{recursive:true});
const lines=[];
for(const file of ['main.js','manifest.json','styles.css','README.md','ACCEPTANCE.md','INSTALL_RU.md','LICENSE']) {
 await copyFile(file,root+'/'+file);
 lines.push(createHash('sha256').update(await readFile(file)).digest('hex')+'  '+file);
}
await writeFile(root+'/SHA256SUMS.txt',lines.join('\n')+'\n');
console.log('Prepared '+root+' (no personal data).');
