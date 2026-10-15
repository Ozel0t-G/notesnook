const fs=require('fs');
const base=require('/Users/ozel0t/Notesnook/qa/core-master-v2-20261012/claude/d2-aa-scroll-original-vitest.config.cjs');
const root='/Users/ozel0t/Notesnook/notesnook';
const out='/Users/ozel0t/Documents/Codex/2026-10-15/veyran-master-v2-a-mac/outputs/a12-upper-list-tools';
const names=['packages/editor/src/toolbar/tools/lists.tsx','packages/editor/src/toolbar/tools/mac-format.tsx','packages/editor/src/toolbar/__tests__/mac-format-menu.test.tsx'];
const files=Object.fromEntries(names.map(p=>[root+'/'+p,out+'/proposal/'+p]));
module.exports={...base,cacheDir:out+'/logs/vite-cache',plugins:[{name:'a12-external-exact-source-overlay',enforce:'pre',transform(code,id){const path=id.split('?')[0];return files[path]?{code:fs.readFileSync(files[path],'utf8'),map:null}:null;}},...(base.plugins||[])],test:{...base.test,include:['src/toolbar/__tests__/mac-format-menu.test.tsx'],cache:{dir:out+'/logs/vitest-cache'},pool:'forks',poolOptions:{forks:{singleFork:true}},reporters:['default','json'],outputFile:{json:out+'/logs/vitest-result.json'}}};
