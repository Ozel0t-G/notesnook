const fs=require('fs');
const root='/Users/ozel0t/Notesnook/notesnook';
const task='/Users/ozel0t/Documents/Codex/2026-10-15/veyran-master-v2-a-mac';
const {ESLint}=require(root+'/node_modules/eslint');
(async()=>{
 const lint=new ESLint({cwd:root,useEslintrc:false,overrideConfigFile:root+'/.eslintrc.js',resolvePluginsRelativeTo:root,cache:false});
 const names=['packages/editor/src/toolbar/tools/lists.tsx','packages/editor/src/toolbar/tools/mac-format.tsx','packages/editor/src/toolbar/__tests__/mac-format-menu.test.tsx'];
 const results=[];
 for(const name of names){
  const baseline=await lint.lintText(fs.readFileSync(task+'/outputs/a12-upper-list-tools/before/'+name,'utf8'),{filePath:root+'/'+name});
 const current=await lint.lintText(fs.readFileSync(task+'/outputs/a12-upper-list-tools/proposal/'+name,'utf8'),{filePath:root+'/'+name});
  results.push({path:name,baseline,current});
 }
 fs.writeFileSync(task+'/outputs/a12-upper-list-tools/logs/eslint-results.json',JSON.stringify(results,null,2)+'\n');
 const formatter=await lint.loadFormatter('stylish');
 process.stdout.write(formatter.format(results.flatMap(x=>x.current)));
 const errors=results.flatMap(x=>x.current).reduce((s,x)=>s+x.errorCount,0);
 const warnings=results.flatMap(x=>x.current).reduce((s,x)=>s+x.warningCount,0);
 console.log(JSON.stringify({errors,warnings,readonlyRoot:true}));
 process.exitCode=errors?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
