"""Copy only existing CC0 demo assets into engine projects. No network required."""
from pathlib import Path
import json, shutil
root=Path(__file__).resolve().parents[3]
hybrid=Path(__file__).resolve().parents[1]
source=root/'src/assets/models/quaternius-ultimate-fantasy-rts'
names=['TownCenter_FirstAge_Level3','Houses_FirstAge_1_Level3','Resource_Tree1','Windmill_FirstAge','Farm_FirstAge_Level1_Wheat','Houses_FirstAge_2_Level3','Houses_SecondAge_1_Level2','Market_FirstAge_Level3','Barracks_FirstAge_Level1','Storage_FirstAge_Level1','WatchTower_FirstAge_Level1','TowerHouse_FirstAge','Port_FirstAge_Level1','Resource_PineTree','Resource_Tree2','Rock_Group','Crate_Big_Stack2','Temple_SecondAge_Level2','Resource_Rock_1']
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

 # KayKit CC0 animated characters + Quaternius CC0 animals + Kenney CC0 boats (vendored in repo)
 kay=root/'src/assets/models/kaykit-adventurers/Characters'
 for f in list(kay.glob('*.glb'))+list(kay.glob('*.png')): shutil.copy2(f,target/f.name)
 shutil.copy2(root/'src/assets/models/kaykit-adventurers/LICENSE.txt',target/'KAYKIT-LICENSE.txt')
 an=root/'src/assets/models/quaternius-ultimate-animated-animals/glTF'
 for name in ['Horse','Cow']:
  file=an/(name+'.gltf');data=json.loads(file.read_text());shutil.copy2(file,target/file.name)
  for entry in data.get('buffers',[])+data.get('images',[]):
   uri=entry.get('uri','')
   if uri and not uri.startswith('data:'):
    dest=target/uri;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file.parent/uri,dest)
 (target/'Textures').mkdir(exist_ok=True);shutil.copy2(root/'src/assets/models/kenney-watercraft/glTF/Textures/colormap.png',target/'Textures/colormap.png')
 for boat in ['boat-sail-a.glb','ship-cargo-a.glb','boat-fishing-small.glb']:
  bf=root/'src/assets/models/kenney-watercraft/glTF'/boat
  if bf.exists(): shutil.copy2(bf,target/boat)
 fixture=hybrid/'evidence/frozen-frame.json'
 if fixture.exists():shutil.copy2(fixture,target/'frozen-frame.json')
 print('Prepared',target)
