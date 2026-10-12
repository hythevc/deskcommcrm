const fs=require('node:fs'),assert=require('node:assert/strict');
const g=JSON.parse(fs.readFileSync('graphify-out/graph.json','utf8')),ids=new Set(g.nodes.map(n=>n.id)),labels=new Set(['EXTRACTED','INFERRED','AMBIGUOUS']);
assert.equal(ids.size,g.nodes.length);assert(g.nodes.length>1000);assert(g.edges.length>1000);
for(const n of g.nodes){assert(labels.has(n.status));if(n.type==='file'){assert(n.git_blob);assert.match(n.sha256,/^[a-f0-9]{64}$/)}assert(labels.has(n.community_status))}
for(const e of g.edges){assert(ids.has(e.source));assert(ids.has(e.target));assert(labels.has(e.status));assert(e.evidence.file);assert(e.evidence.line>=1)}
assert(g.communities.groups.some(c=>c.file_count>1));assert(g.communities.groups.every(c=>c.status==='INFERRED'));
assert(fs.readFileSync('AGENTS.md','utf8').includes('graphify-out/GRAPH_REPORT.md'));
assert(fs.existsSync('graphify-out/GRAPH_REPORT.md'));assert(fs.existsSync('graphify-out/index.html'));
console.log(JSON.stringify({valid:true,nodes:g.nodes.length,edges:g.edges.length,cross_file_communities:g.communities.groups.filter(c=>c.file_count>1).length}));
