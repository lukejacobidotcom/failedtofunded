import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(root,'../../survivor');
await mkdir(path.join(root,'.build'),{recursive:true});
await mkdir(path.join(out,'assets'),{recursive:true});
const common={absWorkingDir:root,bundle:true,jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'};
await build({...common,entryPoints:['src/render.tsx'],platform:'node',format:'esm',outfile:path.join(root,'.build/render.mjs'),banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'}});
const {render}=await import(pathToFileURL(path.join(root,'.build/render.mjs')));
const client=await build({...common,entryPoints:{app:'src/client.tsx',site:'src/app/globals.css'},platform:'browser',format:'esm',target:['es2020'],minify:true,outdir:path.join(out,'assets'),entryNames:'[name]-[hash]',metafile:true});
const assets=Object.keys(client.metafile.outputs).map(x=>path.basename(x));
const js=assets.find(x=>x.startsWith('app-')&&x.endsWith('.js'));
const css=assets.find(x=>x.startsWith('site-')&&x.endsWith('.css'));
if(!js||!css)throw new Error('Missing generated assets');
for(const page of ['home','privacy','manage']){
  const folder=page==='home'?out:path.join(out,page);await mkdir(folder,{recursive:true});
  const canonical='https://failedtofunded.com/survivor'+(page==='home'?'':'/'+page);
  const title=page==='home'?'Vest Slippage | Share your experience':page==='privacy'?'Privacy & data use | Vest Slippage':'Manage your report | Vest Slippage';
  const description='Share your experience with slippage on Vest Markets. Help the Failed to Funded initiative gather reports, document the impact, and seek answers.';
  const html='<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>'+title+'</title><meta name="description" content="'+description+'"><meta name="robots" content="'+(page==='manage'?'noindex,nofollow':'index,follow')+'"><link rel="canonical" href="'+canonical+'"><meta property="og:title" content="'+title+'"><meta property="og:description" content="'+description+'"><meta property="og:url" content="'+canonical+'"><meta property="og:type" content="website"><link rel="icon" href="/survivor/favicon.svg"><link rel="stylesheet" href="/survivor/assets/'+css+'"><script type="module" src="/survivor/assets/'+js+'"></script></head><body data-page="'+page+'"><noscript><p style="padding:16px;text-align:center;background:#ffe9c9">Please enable JavaScript to submit or manage a report securely.</p></noscript><div id="root">'+render(page)+'</div></body></html>\n';
  await writeFile(path.join(folder,'index.html'),html);
}
console.log(JSON.stringify({pages:3,js,css,output:out}));
