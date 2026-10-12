"""Read committed Git blobs without modifying checkout or pending changes."""
from pathlib import Path
import subprocess,json,sys
ref=sys.argv[1] if len(sys.argv)>1 else 'HEAD'
base=subprocess.check_output(['git','rev-parse',ref+'^{commit}'],text=True).strip()
entries=[]
for line in subprocess.check_output(['git','ls-tree','-r',base],text=True).splitlines():
 meta,path=line.split('\t',1);mode,kind,oid=meta.split()
 if kind=='blob' and Path(path).suffix.lower() in {'.ts','.tsx','.js','.mjs','.cjs','.md','.sql','.py','.sh','.json','.yml','.yaml','.css'} and not Path(path).name.startswith('.env') and not path.startswith('graphify-out/'):
  entries.append((path,oid))
r=subprocess.run(['git','cat-file','--batch'],input=''.join(o+'\n' for _,o in entries).encode(),stdout=subprocess.PIPE,check=True)
b=r.stdout;offset=0;files=[]
for path,oid in entries:
 end=b.index(b'\n',offset);size=int(b[offset:end].split()[-1]);data=b[end+1:end+1+size];offset=end+size+2
 files.append({'path':path,'blob':oid,'content':data.decode('utf8','replace')})
p=Path('.prova/graphify');p.mkdir(parents=True,exist_ok=True);(p/'snapshot.json').write_text(json.dumps({'base':base,'files':files}))
print(json.dumps({'source_commit':base,'files':len(files)}))
