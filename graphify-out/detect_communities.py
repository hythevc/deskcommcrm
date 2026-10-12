"""Deterministic weighted cross-file communities; inference, never proof."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('.prova/graphify/vendor').resolve()))
import networkx as nx
p=Path('graphify-out/graph.json');d=json.loads(p.read_text());g=nx.Graph()
for n in d['nodes']:
 if n['type'] in ['file','topic','sql_table','sql_function','sql_view']:g.add_node(n['id'])
weights={'imports':3.0,'reexports':3.0,'documents_reference':2.0,'declares_sql':1.0,'candidate_topic':0.15}
for e in d['edges']:
 if e['type'] in weights and e['source'] in g and e['target'] in g:
  a,b=e['source'],e['target'];g.add_edge(a,b,weight=g.get_edge_data(a,b,{}).get('weight',0)+weights[e['type']])
communities=nx.community.louvain_communities(g,seed=17,weight='weight',resolution=1)
communities=sorted(communities,key=lambda c:(-sum(x.startswith('file:') for x in c),min(c)))
lookup={n:i for i,c in enumerate(communities) for n in c}
for n in d['nodes']:
 n['community']=lookup.get(n['id'],lookup.get('file:'+n.get('file','')))
 n['community_status']='INFERRED' if n['community'] is not None else 'AMBIGUOUS'
summaries=[]
for i,c in enumerate(communities):
 files=sorted(x.removeprefix('file:') for x in c if x.startswith('file:'))
 if files:summaries.append({'id':i,'status':'INFERRED','file_count':len(files),'examples':files[:8],'topics':sorted(x.removeprefix('topic:') for x in c if x.startswith('topic:'))})
d['communities']={'method':'NetworkX 3.5 weighted Louvain; deterministic seed 17; files/SQL/topics only; symbols inherit file assignment','status':'INFERRED','weights':weights,'groups':summaries,'isolated_file_count':sum(g.degree(n)==0 for n in g if n.startswith('file:'))}
p.write_text(json.dumps(d,separators=(',',':')))
print(json.dumps({'communities_with_files':len(summaries),'cross_file_communities':sum(x['file_count']>1 for x in summaries),'isolated_files':d['communities']['isolated_file_count']}))
