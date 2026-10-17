"""Assemble measured evidence only; never invent missing engine results."""
from pathlib import Path
import json, struct
here=Path(__file__).resolve().parents[1]
records={}
for engine in ['three','godot','unity']:
 records[engine]={}
 for view in 'ABC':
  choices=[here/'evidence'/f'{engine}-{view}.png.json',here/'evidence'/f'{engine}-{view}.json']
  file=next((p for p in choices if p.exists()),None)
  if file:
   m=json.loads(file.read_text());image=here/'evidence'/f'{engine}-{view}.png'
   with image.open('rb') as f:f.seek(16);width,height=struct.unpack('>II',f.read(8))
   assert (width,height)==(1600,1000),f'Wrong capture size: {image}'
   assert m['pops']==500 and m['digest']=='68c9dc948474e127',f'Wrong reference frame: {image}'
   assert m['view'] in [view,'ABC'.index(view)],f'Wrong view metadata: {image}'
   m['width']=width;m['height']=height;records[engine][view]=m
for name in ['rust-benchmark','ts-reference']:
 file=here/'evidence'/(name+'.jsonl')
 records[name]=[json.loads(s) for s in file.read_text().splitlines()] if file.exists() else []
(here/'evidence/results.json').write_text(json.dumps(records,indent=2))
