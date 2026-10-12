// Evidence-first extraction from an immutable committed source snapshot.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ts = require('../node_modules/typescript');
const input = JSON.parse(fs.readFileSync('.prova/graphify/snapshot.json','utf8'));
const nodes = new Map(), edges = [], seen = new Set(), files = new Set(input.files.map(f=>f.path));
const node = (id,type,label,status='EXTRACTED',extra={}) => { nodes.set(id,{...nodes.get(id),id,type,label,status,...extra});return id; };
const edge = (source,target,type,status,evidence) => {const k=JSON.stringify([source,target,type,evidence?.file,evidence?.line]);if(!seen.has(k)){seen.add(k);edges.push({source,target,type,status,evidence});}};
const fileId = p => 'file:'+p;
const at = (f,pos) => ({file:f.path,line:f.content.slice(0,pos).split('\n').length});
function resolve(from,spec){
 const bases=spec.startsWith('@/')?[spec.slice(2)]:spec.startsWith('.')?[path.posix.normalize(path.posix.join(path.posix.dirname(from),spec))]:[spec,path.posix.normalize(path.posix.join(path.posix.dirname(from),spec))];
 for(const base of bases)for(const suffix of ['', '.ts','.tsx','.js','.mjs','.json','/index.ts','/index.tsx','/index.js'])if(files.has(base+suffix))return base+suffix;
 return null;
}
const topics={authentication:/\bauth(?:entication)?\b|\bmfa\b|autentica/i,tenancy:/\btenant\b|\brls\b|organization_id/i,privacy:/\blgpd\b|redact|retention/i,agents:/\bagent\b|\bllm\b|\brag\b|embedding/i,messaging:/whatsapp|webhook|conversation/i,operations:/\bdocker\b|\bdeploy\b|backup|scheduler/i,interface:/\bcomponent\b|accessibility|tailwind|\bui\b/i,governance:/\brbac\b|permission|audit/i};
let parseErrors=0;
for(const f of input.files){
 const fid=node(fileId(f.path),'file',f.path,'EXTRACTED',{path:f.path,git_blob:f.blob,sha256:crypto.createHash('sha256').update(f.content).digest('hex')});
 const ext=path.extname(f.path);
 if(/\.(tsx?|[cm]?js)$/.test(ext)){
  const sf=ts.createSourceFile(f.path,f.content,ts.ScriptTarget.Latest,true,ext==='.tsx'?ts.ScriptKind.TSX:ext.endsWith('js')?ts.ScriptKind.JS:ts.ScriptKind.TS);
  const valid=!sf.parseDiagnostics.length;if(!valid)parseErrors++;
  for(const st of sf.statements){
   if(ts.isImportDeclaration(st)||ts.isExportDeclaration(st)){
    const spec=st.moduleSpecifier;if(spec&&ts.isStringLiteral(spec)){
     const target=resolve(f.path,spec.text);let tid,status='EXTRACTED';
     if(target)tid=fileId(target);
     else if(spec.text.startsWith('.')||spec.text.startsWith('@/')){tid=node('unresolved:'+f.path+':'+spec.text,'unresolved_reference',spec.text,'AMBIGUOUS');status='AMBIGUOUS';}
     else tid=node('package:'+spec.text,'package',spec.text);
     if(!nodes.has(tid)&&target)node(tid,'file',target,'EXTRACTED',{path:target});
     edge(fid,tid,ts.isImportDeclaration(st)?'imports':'reexports',status,at(f,spec.getStart(sf)));
    }
   }
   const decls=ts.isVariableStatement(st)?st.declarationList.declarations:[st];
   for(const d of decls){if(d.name&&ts.isIdentifier(d.name)){
    const ev=at(f,d.getStart(sf));const sid=node('symbol:'+f.path+':'+ev.line+':'+d.name.text,'symbol',d.name.text,valid?'EXTRACTED':'AMBIGUOUS',{file:f.path,line:ev.line,syntax_kind:ts.SyntaxKind[d.kind]});edge(fid,sid,'declares',valid?'EXTRACTED':'AMBIGUOUS',ev);
   }}
  }
  if(/^app\/.*\/(?:route\.ts|page\.tsx)$/.test(f.path)){
   const route='/'+f.path.split('/').slice(1,-1).filter(s=>!(s.startsWith('(')&&s.endsWith(')'))).join('/');const id=node('route:'+route,'route',route,'INFERRED',{rule:'App Router filesystem convention'});edge(fid,id,'implements_route','INFERRED',{file:f.path,line:1});
  }
 }
 if(ext==='.md'){
  let section=0;f.content.split('\n').forEach((line,i)=>{
   if(/^#{1,6}\s/.test(line)){const id=node('section:'+f.path+':'+(i+1),'doc_section',path.basename(f.path)+' section '+(++section),'EXTRACTED',{file:f.path,line:i+1,heading_level:line.match(/^#+/)[0].length});edge(fid,id,'contains_section','EXTRACTED',{file:f.path,line:i+1});}
   const targets=[...line.matchAll(/\]\(([^\s)]+)(?:[^)]*)\)/g)].map(m=>m[1]).concat([...line.matchAll(/`([^`]+\.(?:tsx?|md|sql|py|sh|json))`/g)].map(m=>m[1]));
   for(let spec of targets){if(/^[a-z]+:|^#|^\/\//i.test(spec))continue;spec=spec.split('#')[0].replace(/:\d+$/,'');const target=resolve(f.path,spec.replace(/^\//,''));
    if(target){if(!nodes.has(fileId(target)))node(fileId(target),'file',target,'EXTRACTED',{path:target});edge(fid,fileId(target),'documents_reference','EXTRACTED',{file:f.path,line:i+1});}
    else if(/\.(?:tsx?|md|sql|py|sh|json)$/.test(spec)){const id=node('unresolved-doc:'+f.path+':'+spec,'unresolved_reference',spec,'AMBIGUOUS');edge(fid,id,'unresolved_doc_reference','AMBIGUOUS',{file:f.path,line:i+1});}
   }
  });
 }
 if(ext==='.sql'){
  const clean=f.content.replace(/--[^\n]*/g,m=>' '.repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g,m=>m.replace(/[^\n]/g,' '));
  const regex=/\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|FUNCTION|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[A-Za-z_][\w$]*"|[A-Za-z_][\w$]*)(?:\.(?:"[A-Za-z_][\w$]*"|[A-Za-z_][\w$]*))?)/gi;
  for(const m of clean.matchAll(regex)){const name=m[2].replaceAll('"','');const id=node('sql:'+m[1].toLowerCase()+':'+name,'sql_'+m[1].toLowerCase(),name,'EXTRACTED',{extraction:'lexical declaration token; not a database-state claim'});edge(fid,id,'declares_sql','EXTRACTED',at(f,m.index));}
 }
 for(const [topic,re]of Object.entries(topics))if(re.test(f.content)){const tid=node('topic:'+topic,'topic',topic,'INFERRED',{rule:'keyword presence; context and negation not resolved'});edge(fid,tid,'candidate_topic','INFERRED',{file:f.path,line:1});}
}
const out={schema_version:1,provenance:{source_commit:input.base,source_mode:'committed HEAD; excludes pending working-tree changes and generated graph output',extractor:'local TypeScript compiler AST plus lexical SQL and Markdown reference extraction',privacy:'no source bodies, credentials, literal account data or heading text copied into graph',parse_error_files:parseErrors,limits:['No runtime or security verification','SQL tokens are lexical, not execution/dependency proof','Doc sections retain location, not raw heading text','Unresolved references remain AMBIGUOUS','Semantic topics and route conventions are INFERRED']},nodes:[...nodes.values()].sort((a,b)=>a.id.localeCompare(b.id)),edges};
fs.writeFileSync('graphify-out/graph.json',JSON.stringify(out));console.log(JSON.stringify({files:input.files.length,nodes:out.nodes.length,edges:edges.length,parse_error_files:parseErrors}));
