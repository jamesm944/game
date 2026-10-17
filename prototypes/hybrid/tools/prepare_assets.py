"""Copy only existing CC0 demo assets into engine projects. No network required."""
from pathlib import Path
import json, shutil
root=Path(__file__).resolve().parents[3]
hybrid=Path(__file__).resolve().parents[1]
source=root/'src/assets/models/quaternius-ultimate-fantasy-rts'
names=['TownCenter_FirstAge_Level3','Houses_FirstAge_1_Level3','Resource_Tree1','Windmill_FirstAge','Farm_FirstAge_Level1_Wheat']
for target in [hybrid/'godot/assets',hybrid/'unity/Assets/StreamingAssets/Imported']:
 target.mkdir(parents=True,exist_ok=True)
 for name in names:
  file=source/'glTF'/(name+'.gltf');data=json.loads(file.read_text())
  shutil.copy2(file,target/file.name)
  for entry in data.get('buffers',[])+data.get('images',[]):
   uri=entry.get('uri','')
   if uri and not uri.startswith('data:'):
    dest=target/uri;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file.parent/uri,dest)
 shutil.copy2(source/'LICENSE.md',target/'QUATERNIUS-LICENSE.md')
 shutil.copy2(root/'src/assets/models/terrain/ambientcg-grass001/Grass001_1K-JPG_Color.jpg',target/'grass.jpg')
 shutil.copy2(root/'src/assets/models/terrain/LICENSE.md',target/'TERRAIN-LICENSE.md')
 fixture=hybrid/'evidence/frozen-frame.json'
 if fixture.exists():shutil.copy2(fixture,target/'frozen-frame.json')
 print('Prepared',target)
