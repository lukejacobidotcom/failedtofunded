import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source=process.argv[2];
if(!source || !path.isAbsolute(source))throw new Error('Pass the absolute Vest Slippage Sites checkout path.');
const manifest=JSON.parse(readFileSync(path.join(source,'.openai/hosting.json'),'utf8'));
if(manifest.project_id!=='appgprj_6ad7e6b8b5b08191a1983856c0529f7a')throw new Error('Wrong Sites project.');
const root=path.dirname(fileURLToPath(import.meta.url));
for(const file of ['app/page.tsx','app/report-form.tsx','app/privacy/page.tsx','app/manage/page.tsx','app/globals.css','lib/report-validation.mjs','lib/public-config.mjs']){
  const to=path.join(root,'src',file);mkdirSync(path.dirname(to),{recursive:true});
  writeFileSync(to,readFileSync(path.join(source,file),'utf8').replace('@import "tailwindcss";',''));
}
mkdirSync(path.join(root,'../../survivor'),{recursive:true});
writeFileSync(path.join(root,'../../survivor/favicon.svg'),readFileSync(path.join(source,'public/favicon.svg')));
