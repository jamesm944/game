# THROWAWAY visual client. Authoritative state comes from Rust TCP4188.
extends Node3D
var camera: Camera3D
var tcp:=StreamPeerTCP.new()
var buffer:=""
var latest: Dictionary={}
var previous: Dictionary={}
var received_at:=0.0
var view:=0
var label: Label
var pops_mesh: MultiMeshInstance3D
var seq:=int(Time.get_unix_time_from_system()*1000)
var frame_ms: Array[float]=[]
var seconds:=0.0
var wall_start:=Time.get_ticks_msec()
var screenshot_done:=false
var mode_names=["A · Commander's view","B · Life in the settlement","C · Coastal frontier"]
var frame_count:=0
var last_frame_us:=0
var initial_camera:=Vector3.ZERO
var target:=Vector3.ZERO
var capture_path:=""
var start_view:=0
var reference: Dictionary={}
var last_connect:=0

func coast(z: float)->float:return -18+sin(z*.10)*4+sin(z*.27)*1.4
func height(x: float,z: float)->float:
 var d=x-coast(z)
 if d<0:return max(-5,d*.19-.14)
 var hills=max(0,Vector2(x*.8,z).length()-25)
 return -.14+min(d,7)*.11+hills*.08*(1+.45*sin(z*.13+x*.07))

func _ready():
 for arg in OS.get_cmdline_user_args():
  if arg.begins_with("--capture="):capture_path=arg.trim_prefix("--capture=")
  if arg.begins_with("--view="):start_view=int(arg.trim_prefix("--view="))
 if capture_path!="":reference=JSON.parse_string(FileAccess.get_file_as_string("res://assets/frozen-frame.json"))
 var env=WorldEnvironment.new();var e=Environment.new()
 e.background_mode=Environment.BG_COLOR;e.background_color=Color("a9bec5")
 e.ambient_light_source=Environment.AMBIENT_SOURCE_COLOR;e.ambient_light_color=Color("c6dfe8");e.ambient_light_energy=.3
 e.tonemap_mode=Environment.TONE_MAPPER_FILMIC
 env.environment=e;add_child(env)
 var sun=DirectionalLight3D.new();sun.light_color=Color("fff1d1");sun.light_energy=.7;sun.shadow_enabled=true;sun.rotation_degrees=Vector3(-58,-35,0);add_child(sun)
 terrain()
 var water=MeshInstance3D.new();var plane=PlaneMesh.new();plane.size=Vector2(320,320);water.mesh=plane;water.position.y=-.02
 var wm=ShaderMaterial.new();wm.shader=load("res://water.gdshader");water.material_override=wm;add_child(water)
 await get_tree().process_frame
 village()
 camera=Camera3D.new();camera.far=700;add_child(camera);camera.current=true;set_view(start_view)
 pops_mesh=MultiMeshInstance3D.new();var mm=MultiMesh.new();mm.transform_format=MultiMesh.TRANSFORM_3D;mm.use_colors=true
 var capsule=CapsuleMesh.new();capsule.radius=.19;capsule.height=.8;capsule.radial_segments=8;capsule.rings=2
 var mat=StandardMaterial3D.new();mat.vertex_color_use_as_albedo=true;capsule.material=mat
 mm.mesh=capsule;mm.instance_count=0;pops_mesh.multimesh=mm;add_child(pops_mesh)
 wall_start=Time.get_ticks_msec();print("SCENE_READY");hud();tcp.connect_to_host("127.0.0.1",4188)

func terrain():
 var resolution=400;var verts=PackedVector3Array();var normals=PackedVector3Array();var colors=PackedColorArray();var indices=PackedInt32Array()
 for j in range(resolution+1):
  var z=-160+j*320.0/resolution
  for i in range(resolution+1):
   var x=-160+i*320.0/resolution
   verts.append(Vector3(x,height(x,z),z))
   var dx=(height(x+.05,z)-height(x-.05,z))/.1;var dz=(height(x,z+.05)-height(x,z-.05))/.1
   normals.append(Vector3(-dx,1,-dz).normalized())
   var variation=sin(x*.41+sin(z*.17))*cos(z*.37)*.04
   var c=Color("849658");c=c.lightened(max(0,variation)) if variation>0 else c.darkened(-variation)
   var path=min(abs(z-sin(x*.2)*1.5),abs(x-6-sin(z*.17)))
   c=c.lerp(Color("b3a07b"),max(0,1-path/1.15)*.8);colors.append(c)
 for j in range(resolution):
  for i in range(resolution):
   var a=j*(resolution+1)+i;var b=a+resolution+1
   indices.append_array(PackedInt32Array([a,a+1,b,a+1,b+1,b]))
 var arrays=[];arrays.resize(Mesh.ARRAY_MAX);arrays[Mesh.ARRAY_VERTEX]=verts;arrays[Mesh.ARRAY_NORMAL]=normals;arrays[Mesh.ARRAY_COLOR]=colors;arrays[Mesh.ARRAY_INDEX]=indices
 var mesh=ArrayMesh.new();mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,arrays)
 var instance=MeshInstance3D.new();instance.mesh=mesh
 var mat=ShaderMaterial.new();mat.shader=load("res://terrain.gdshader");mat.set_shader_parameter("grass_texture",load("res://assets/grass.jpg"));instance.material_override=mat;add_child(instance)

func plant(name: String,x: float,z: float,width: float,turn: float=0)->Node3D:
 var packed=load("res://assets/"+name+".gltf") as PackedScene
 var obj=packed.instantiate() as Node3D
 var box=AABB();var first=true
 for node in obj.find_children("*","MeshInstance3D",true,false):
  var local=node.get_aabb()
  local=node.transform*local
  box=local if first else box.merge(local);first=false
 var scale_factor=width/max(box.size.x,box.size.z)
 var wrapper=Node3D.new();add_child(wrapper);wrapper.add_child(obj)
 obj.scale=Vector3.ONE*scale_factor;obj.position=Vector3(-box.get_center().x,-box.position.y,-box.get_center().z)*scale_factor
 wrapper.position=Vector3(x,height(x,z),z);wrapper.rotation.y=turn
 return wrapper

func village():
 plant("TownCenter_FirstAge_Level3",5,-4,7)
 for pos in [Vector2(-4,4),Vector2(3,8),Vector2(12,6),Vector2(14,-5),Vector2(3,-13),Vector2(-6,-8),Vector2(14,-15),Vector2(22,4)]:plant("Houses_FirstAge_1_Level3",pos.x,pos.y,3.8,.25*pos.x)
 plant("Windmill_FirstAge",22,-11,4)
 for pos in [Vector2(24,-2),Vector2(25,5),Vector2(32,0),Vector2(32,7)]:plant("Farm_FirstAge_Level1_Wheat",pos.x,pos.y,5)
 for i in range(190):
  var x=sin(i*127.1)*65+19;var z=sin(i*311.7)*70
  if x<coast(z)+5 or (x>-12 and x<37 and abs(z)<23):continue
  var tree=plant("Resource_Tree1",x,z,3,i);tree.scale=Vector3.ONE*(.75+.35*(1+sin(i)))
 var wood=StandardMaterial3D.new();wood.albedo_color=Color("8b7351")
 for i in range(22):
  var b=MeshInstance3D.new();var box=BoxMesh.new();box.size=Vector3(.38,.16,2.5);b.mesh=box;b.material_override=wood;b.position=Vector3(-24+i*.4,.35,12);add_child(b)

func set_view(index: int):
 view=posmod(index,3)
 if view==0:
  camera.projection=Camera3D.PROJECTION_ORTHOGONAL;camera.keep_aspect=Camera3D.KEEP_HEIGHT;camera.size=55;camera.position=Vector3(4,66,46);target=Vector3(4,0,0)
 else:
  camera.projection=Camera3D.PROJECTION_PERSPECTIVE;camera.keep_aspect=Camera3D.KEEP_HEIGHT;camera.fov=44
  camera.position=Vector3(35,25,39) if view==1 else Vector3(-54,43,61);target=Vector3(5,1,1) if view==1 else Vector3(-4,0,-8)
 camera.look_at(target);initial_camera=camera.position

func hud():
 var layer=CanvasLayer.new();add_child(layer)
 var panel=PanelContainer.new();panel.position=Vector2(22,22);panel.custom_minimum_size=Vector2(350,0);layer.add_child(panel)
 var stack=VBoxContainer.new();panel.add_child(stack)
 label=Label.new();label.add_theme_font_size_override("font_size",16);stack.add_child(label)
 var row=HBoxContainer.new();stack.add_child(row)
 for i in range(3):
  var b=Button.new();b.text=["A Tactical","B Settlement","C Panorama"][i];b.pressed.connect(set_view.bind(i));row.add_child(b)
 var actions=HBoxContainer.new();stack.add_child(actions)
 for item in [["Move group","move"],["Resume work","work"],["Pause","pause"]]:
  var b=Button.new();b.text=item[0];b.pressed.connect(send_command.bind(item[1]));actions.add_child(b)
 var help=Label.new();help.text="Arrow keys: views · R: reset · wheel: zoom\nRight drag: pan · left drag: orbit\nLive Rust slice: movement / needs / deliveries\nNot the full RTS simulation port";stack.add_child(help)

func send_command(kind: String):
 seq+=1
 if tcp.get_status()==StreamPeerTCP.STATUS_CONNECTED:tcp.put_data((JSON.stringify({"kind":kind,"seq":seq,"x":-10000,"z":12000})+"\n").to_utf8_buffer())

func _unhandled_input(event):
 if event is InputEventKey and event.pressed:
  if event.keycode==KEY_RIGHT:set_view(view+1)
  if event.keycode==KEY_LEFT:set_view(view-1)
  if event.keycode==KEY_R:set_view(view)
 if event is InputEventMouseButton and event.pressed:
  if event.button_index==MOUSE_BUTTON_WHEEL_UP:
   if view==0:camera.size=max(18,camera.size*.9)
   else:camera.position=target+(camera.position-target)*.9
  if event.button_index==MOUSE_BUTTON_WHEEL_DOWN:
   if view==0:camera.size=min(100,camera.size*1.1)
   else:camera.position=target+(camera.position-target)*1.1
 if event is InputEventMouseMotion:
  if event.button_mask&MOUSE_BUTTON_MASK_RIGHT:
   var offset=(camera.global_basis.x*(-event.relative.x)+camera.global_basis.y*event.relative.y)*.05
   camera.position+=offset;target+=offset
  if event.button_mask&MOUSE_BUTTON_MASK_LEFT:
   var offset=camera.position-target;offset=offset.rotated(Vector3.UP,-event.relative.x*.005);camera.position=target+offset;camera.look_at(target)

func _process(delta: float):
 if not camera or not label:return
 seconds=(Time.get_ticks_msec()-wall_start)/1000.0;frame_count+=1
 var now_us=Time.get_ticks_usec()
 if seconds>3 and last_frame_us>0:frame_ms.append((now_us-last_frame_us)/1000.0)
 last_frame_us=now_us
 tcp.poll()
 if tcp.get_status()==StreamPeerTCP.STATUS_CONNECTED:
  var count=tcp.get_available_bytes()
  if count>0:
   buffer+=tcp.get_utf8_string(count)
   var split=buffer.split("\n");buffer=split[split.size()-1]
   if split.size()>1:
    var s=JSON.parse_string(split[split.size()-2])
    if s is Dictionary:
     previous=latest;latest=s;received_at=Time.get_ticks_msec()/1000.0
 if tcp.get_status() in [StreamPeerTCP.STATUS_NONE,StreamPeerTCP.STATUS_ERROR] and Time.get_ticks_msec()-last_connect>1000:
  buffer="";last_connect=Time.get_ticks_msec();tcp.connect_to_host("127.0.0.1",4188)
 if not reference.is_empty():latest=reference;previous=reference
 if latest.has("pops"):
  var pops=latest.pops;var mm=pops_mesh.multimesh
  if mm.instance_count!=pops.size():mm.instance_count=pops.size()
  var alpha=clamp((Time.get_ticks_msec()/1000.0-received_at)/.033,0,1)
  for i in range(pops.size()):
   var p=pops[i];var x=float(p.x)/1000;var z=float(p.z)/1000
   if previous.has("pops") and previous.pops.size()==pops.size():
    x=lerp(float(previous.pops[i].x)/1000,x,alpha);z=lerp(float(previous.pops[i].z)/1000,z,alpha)
   mm.set_instance_transform(i,Transform3D(Basis.IDENTITY,Vector3(x,height(x,z)+.5,z)))
   mm.set_instance_color(i,Color("3f6f9d") if i%3 else Color("a85d41"))
  label.text="AGEOFWIND · GODOT + RUST\n"+mode_names[view]+"\nTick %d · Pops %d · workers %d\nThreads observed this tick: %d\nSim %.3f ms · stock %d · ack %d\nDigest %s\nRenderer: %s · frame %.2f ms"%[latest.tick,pops.size(),latest.workers,latest.threads_observed,latest.sim_ms,latest.stock,latest.ack,latest.digest,RenderingServer.get_current_rendering_method(),delta*1000]
 else:label.text="GODOT + RUST · Connecting to 127.0.0.1:4188…"
 if seconds>12 and not screenshot_done:
  screenshot_done=true
  if capture_path!="":
   print("CAPTURE_REQUESTED");RenderingServer.force_draw(false)
   get_viewport().get_texture().get_image().save_png(capture_path)
   frame_ms.sort()
   var stats={"engine":"Godot","view":view,"frames":frame_ms.size(),"p50_frame_ms":frame_ms[frame_ms.size()/2],"p95_frame_ms":frame_ms[int(frame_ms.size()*.95)],"pops":latest.get("pops",[]).size(),"tick":latest.get("tick",0),"digest":latest.get("digest",""),"renderer":RenderingServer.get_current_rendering_method(),"viewport":get_viewport().size}
   print("HYBRID_EVIDENCE ",JSON.stringify(stats))
   FileAccess.open(capture_path+".json",FileAccess.WRITE).store_string(JSON.stringify(stats))
   get_tree().quit()
