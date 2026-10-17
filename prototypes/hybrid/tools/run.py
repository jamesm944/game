"""One-command prototype runner. Tools stay outside Git; simulation stays local."""
from pathlib import Path
import argparse, os, shutil, socket, subprocess, time
root=Path(__file__).resolve().parents[3]
here=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('engine',choices=['unity','godot','web','build-unity','bench']);p.add_argument('--view',choices=['A','B','C'],default='A');args=p.parse_args()
subprocess.run(['python3',str(here/'tools/prepare_assets.py')],check=True)
sim=here/'rust-sim/target/release/hybrid-sim-prototype'
subprocess.run(['cargo','build','--release','--manifest-path',str(here/'rust-sim/Cargo.toml')],check=True)
if args.engine=='bench':
 subprocess.run([str(sim),'bench'],check=True);raise SystemExit
editor=os.environ.get('UNITY_EDITOR','/tmp/game-engine-tools/unity-expanded/Unity.pkg.tmp/Payload/Unity/Unity.app/Contents/MacOS/Unity')
player=here/'build/UnityHybrid.app/Contents/MacOS/Ageofwind Unity + Rust prototype'
if args.engine=='build-unity' or (args.engine=='unity' and not player.exists()):
 if not Path(editor).exists():raise SystemExit('Set UNITY_EDITOR to an installed, activated Unity 6000.3.11f1 executable.')
 subprocess.run([editor,'-batchmode','-quit','-projectPath',str(here/'unity'),'-executeMethod','PrototypeBuild.Build','-logFile',str(here/'evidence/unity-build.log')],check=True)
 if args.engine=='build-unity':raise SystemExit
owned=None
try:
 try:
  s=socket.create_connection(('127.0.0.1',4188),timeout=1);s.close()
 except OSError:
  owned=subprocess.Popen([str(sim),'500','4'],cwd=here)
  time.sleep(.5)
 if args.engine=='unity':subprocess.run([str(player),'--view='+str('ABC'.index(args.view))],check=True)
 elif args.engine=='godot':
  engine=os.environ.get('GODOT_BIN',shutil.which('godot') or '/tmp/game-engine-tools/Godot.app/Contents/MacOS/Godot')
  subprocess.run([engine,'--headless','--path',str(here/'godot'),'--editor','--import','--quit'],check=True)
  subprocess.run([engine,'--path',str(here/'godot'),'--rendering-method','forward_plus','--rendering-driver','metal','--resolution','1600x1000','--','--view='+str('ABC'.index(args.view))],check=True)
 else:
  node=os.environ.get('NODE_BIN','/Users/jamesmoss/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
  if not Path(node).exists():node=shutil.which('node')
  subprocess.run([node,str(root/'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5188'],cwd=root,check=True)
finally:
 if owned:owned.terminate();owned.wait(timeout=5)
