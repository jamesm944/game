// THROWAWAY Unity URP visual client; no authoritative game rules live here.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using GLTFast;

[Serializable] public class SimPop {public int id,x,z,tx,tz,food,rest,morale,carried,deliveries;public long wealth;public bool manual;}
[Serializable] public class SimFrame {public string schema,digest;public long tick,stock,ack;public SimPop[] pops;public int workers,threads_observed;public double sim_ms;public bool paused;}
[Serializable] public class SimOrder {public string kind;public long seq;public int x=-10000,z=12000;}
[Serializable] public class CaptureStats {public string engine="Unity URP",digest,gpu,api;public int view,width=1600,height=1000,pops,frames;public long tick,live_tick;public float p50_frame_ms,p95_frame_ms;}
public class HybridPrototype:MonoBehaviour {
 Camera cameraRig; RenderTexture renderTarget; int view; Vector3 target;
 TcpClient socket; StreamWriter writer; Thread reader; volatile string incoming;
 SimFrame latest,previous,reference;float receivedAt;long seq=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();bool stop;
 Mesh popMesh;Material[] capsuleMats;List<Transform> popObjects=new();long liveTick;
 const int HEROES=64;List<GameObject> heroTemplates;List<Transform> heroes=new();List<Animation> heroAnims=new();List<string> heroState=new();
 float[] yaw=new float[4096];List<Transform> boats=new();List<Transform> swayers=new();List<float> swayPhase=new();
 static float Hash(int i,int salt){uint h=(uint)(i*374761393+salt*668265263);h=(h^(h>>13))*1274126177u;return((h^(h>>16))&1023)/1023f;}
 string[] names={"A · Commander's view","B · Life in the settlement","C · Coastal frontier"};
 List<float> frameTimes=new();float elapsed;bool captured;string capturePath="";
 float Coast(float z)=>-18+Mathf.Sin(z*.1f)*4+Mathf.Sin(z*.27f)*1.4f;
 float Height(float x,float z){float d=x-Coast(z);if(d<0)return Mathf.Max(-5,d*.19f-.14f);float hills=Mathf.Max(0,new Vector2(x*.8f,z).magnitude-25);return -.14f+Mathf.Min(d,7)*.11f+hills*.08f*(1+.45f*Mathf.Sin(z*.13f+x*.07f));}
 async void Start(){
  Application.runInBackground=true;Application.targetFrameRate=120;QualitySettings.vSyncCount=0;
  var args=Environment.GetCommandLineArgs();int initial=0;
  foreach(var a in args){if(a.StartsWith("--view="))initial=int.Parse(a.Substring(7));if(a.StartsWith("--capture="))capturePath=a.Substring(10);}
  cameraRig=new GameObject("Camera").AddComponent<Camera>();cameraRig.nearClipPlane=.1f;cameraRig.farClipPlane=700;cameraRig.backgroundColor=new Color(.55f,.64f,.67f);cameraRig.clearFlags=CameraClearFlags.SolidColor;
  renderTarget=new RenderTexture(1600,1000,24,RenderTextureFormat.ARGB32,RenderTextureReadWrite.sRGB);renderTarget.antiAliasing=4;renderTarget.Create();cameraRig.targetTexture=renderTarget;
  RenderSettings.ambientMode=UnityEngine.Rendering.AmbientMode.Flat;RenderSettings.ambientLight=new Color(.42f,.50f,.54f);
  RenderSettings.fog=true;RenderSettings.fogMode=FogMode.Linear;RenderSettings.fogColor=new Color(.55f,.64f,.67f);RenderSettings.fogStartDistance=90;RenderSettings.fogEndDistance=350;
  var sun=new GameObject("Sun").AddComponent<Light>();sun.type=LightType.Directional;sun.intensity=1.1f;sun.color=new Color(1,.87f,.70f);sun.transform.rotation=Quaternion.LookRotation(new Vector3(38,-44,26));sun.shadows=LightShadows.Soft;
  Terrain();Water();SetView(initial);
  var capsule=GameObject.CreatePrimitive(PrimitiveType.Capsule);popMesh=Instantiate(capsule.GetComponent<MeshFilter>().sharedMesh);Destroy(capsule);
  capsuleMats=new Material[6];var palette=new[]{new Color(.16f,.22f,.34f),new Color(.38f,.16f,.10f),new Color(.25f,.30f,.16f),new Color(.42f,.34f,.22f),new Color(.30f,.22f,.30f),new Color(.22f,.26f,.28f)};
  for(int i=0;i<6;i++){capsuleMats[i]=new Material(Shader.Find("Universal Render Pipeline/Lit"));capsuleMats[i].color=palette[i];}
  await Village();heroTemplates=new List<GameObject>();
  foreach(var cn in new[]{"Knight","Barbarian","Rogue","Mage"}){try{var t=await ModelFile(cn+".glb",1.15f);t.SetActive(false);
   foreach(var tr in t.GetComponentsInChildren<Transform>(true)){var n=tr.name;if(n.Contains("Shield")||n.Contains("Sword")||n.Contains("Crossbow")||n.Contains("Wand")||n.Contains("Spellbook")||n.Contains("Axe")||n.Contains("Dagger")||n.Contains("Bow")||n.Contains("Arrow")||n.Contains("Staff")||n.Contains("Quiver"))tr.gameObject.SetActive(false);}
   heroTemplates.Add(t);}catch(Exception e){Debug.LogWarning("hero "+cn+": "+e.Message);}}
  if(capturePath!="")reference=JsonUtility.FromJson<SimFrame>(File.ReadAllText(Path.Combine(Application.streamingAssetsPath,"Imported/frozen-frame.json")));Connect();
 }
 void Terrain(){
  int res=400;var vertices=new Vector3[(res+1)*(res+1)];var colors=new Color[vertices.Length];var triangles=new int[res*res*6];
  for(int j=0;j<=res;j++)for(int i=0;i<=res;i++){
   int k=j*(res+1)+i;float x=-160+i*320f/res,z=-160+j*320f/res;vertices[k]=new Vector3(x,Height(x,z),-z);
   Color c=new Color(.23f,.30f,.10f);float path=Mathf.Min(Mathf.Abs(z-Mathf.Sin(x*.2f)*1.5f),Mathf.Abs(x-6-Mathf.Sin(z*.17f)));
   colors[k]=Color.Lerp(c,new Color(.45f,.35f,.19f),Mathf.Max(0,1-path/1.15f)*.8f);
  }
  int cursor=0;for(int j=0;j<res;j++)for(int i=0;i<res;i++){int a=j*(res+1)+i,b=a+res+1;foreach(int v in new[]{a,a+1,b,a+1,b+1,b})triangles[cursor++]=v;}
  var mesh=new Mesh();mesh.indexFormat=UnityEngine.Rendering.IndexFormat.UInt32;mesh.vertices=vertices;mesh.triangles=triangles;mesh.colors=colors;mesh.RecalculateNormals();
  var go=new GameObject("Continuous terrain");go.AddComponent<MeshFilter>().sharedMesh=mesh;var material=new Material(Shader.Find("Prototype/Terrain"));
  var tex=new Texture2D(2,2);tex.LoadImage(File.ReadAllBytes(Path.Combine(Application.streamingAssetsPath,"Imported/grass.jpg")));tex.wrapMode=TextureWrapMode.Repeat;tex.anisoLevel=8;material.SetTexture("_Grass",tex);go.AddComponent<MeshRenderer>().sharedMaterial=material;
 }
 void Water(){var go=GameObject.CreatePrimitive(PrimitiveType.Plane);go.name="Water";go.transform.localScale=new Vector3(32,1,32);go.transform.position=new Vector3(0,-.02f,0);go.GetComponent<MeshRenderer>().material=new Material(Shader.Find("Prototype/Water"));Destroy(go.GetComponent<Collider>());}
 async Task<GameObject> ModelFile(string file,float width){
  var loader=new GltfImport();var url=new Uri(Path.Combine(Application.streamingAssetsPath,"Imported",file)).AbsoluteUri;
  if(!await loader.Load(url))throw new Exception("glTF import failed: "+file);
  var wrapper=new GameObject(file);await loader.InstantiateMainSceneAsync(wrapper.transform);
  var renderers=wrapper.GetComponentsInChildren<Renderer>();var bounds=renderers[0].bounds;foreach(var r in renderers)bounds.Encapsulate(r.bounds);
  float scale=width/Mathf.Max(bounds.size.x,bounds.size.z);
  var center=bounds.center;foreach(Transform child in wrapper.transform){child.position-=new Vector3(center.x,bounds.min.y,center.z);}
  wrapper.transform.localScale=Vector3.one*scale;return wrapper;
 }
 async Task<GameObject> Model(string name,float width){
  var loader=new GltfImport();var url=new Uri(Path.Combine(Application.streamingAssetsPath,"Imported",name+".gltf")).AbsoluteUri;
  if(!await loader.Load(url))throw new Exception("glTF import failed: "+name);
  var wrapper=new GameObject(name);await loader.InstantiateMainSceneAsync(wrapper.transform);
  var renderers=wrapper.GetComponentsInChildren<Renderer>();var bounds=renderers[0].bounds;foreach(var r in renderers)bounds.Encapsulate(r.bounds);
  float scale=width/Mathf.Max(bounds.size.x,bounds.size.z);
  var center=bounds.center;foreach(Transform child in wrapper.transform){child.position-=new Vector3(center.x,bounds.min.y,center.z);}
  wrapper.transform.localScale=Vector3.one*scale;return wrapper;
 }
 void Plant(GameObject template,float x,float z,float turn=0){var o=Instantiate(template);o.SetActive(true);o.transform.position=new Vector3(x,Height(x,z),-z);o.transform.rotation=Quaternion.Euler(0,-turn*Mathf.Rad2Deg,0);}
 async Task Village(){
  var tc=await Model("TownCenter_FirstAge_Level3",7);tc.SetActive(false);Plant(tc,5,-4);
  var house=await Model("Houses_FirstAge_1_Level3",3.8f);house.SetActive(false);
  var house2=await Model("Houses_FirstAge_2_Level3",3.8f);house2.SetActive(false);
  var house3=await Model("Houses_SecondAge_1_Level2",4.2f);house3.SetActive(false);
  var houses=new[]{house,house2,house3};
  var spots=new[]{new Vector2(-4,4),new Vector2(3,8),new Vector2(12,6),new Vector2(14,-5),new Vector2(3,-13),new Vector2(-6,-8),new Vector2(14,-15),new Vector2(22,4),new Vector2(-9,1),new Vector2(-2,-15),new Vector2(9,13),new Vector2(19,11),new Vector2(27,-8),new Vector2(31,10),new Vector2(36,-2),new Vector2(38,8),new Vector2(42,-9),new Vector2(6,-20),new Vector2(-10,-13),new Vector2(24,17)};
  for(int i=0;i<spots.Length;i++)Plant(houses[i%3],spots[i].x,spots[i].y,.25f*spots[i].x+i);
  var market=await Model("Market_FirstAge_Level3",6);market.SetActive(false);Plant(market,12,-11,.4f);
  var barracks=await Model("Barracks_FirstAge_Level1",6.5f);barracks.SetActive(false);Plant(barracks,-3,14,-.3f);
  var storage=await Model("Storage_FirstAge_Level1",4.5f);storage.SetActive(false);Plant(storage,18,2,.2f);Plant(storage,33,14,.9f);
  var tower=await Model("WatchTower_FirstAge_Level1",3);tower.SetActive(false);Plant(tower,-8,10);Plant(tower,26,-16);
  var thouse=await Model("TowerHouse_FirstAge",3.4f);thouse.SetActive(false);Plant(thouse,8,18,.6f);
  var temple=await Model("Temple_SecondAge_Level2",7);temple.SetActive(false);Plant(temple,-12,-4,.15f);
  var port=await Model("Port_FirstAge_Level1",6);port.SetActive(false);Plant(port,Coast(10)+1.5f,10,1.2f);
  var mill=await Model("Windmill_FirstAge",4);mill.SetActive(false);Plant(mill,22,-11);Plant(mill,44,4,.7f);
  var farm=await Model("Farm_FirstAge_Level1_Wheat",5);farm.SetActive(false);foreach(var q in new[]{new Vector2(24,-2),new Vector2(25,5),new Vector2(32,0),new Vector2(32,7),new Vector2(40,14),new Vector2(16,-20)})Plant(farm,q.x,q.y);
  var crate=await Model("Crate_Big_Stack2",1.6f);crate.SetActive(false);Plant(crate,16.5f,4);Plant(crate,Coast(12)+3,12,.5f);Plant(crate,11,-8.5f,1);
  var rock=await Model("Rock_Group",3.5f);rock.SetActive(false);foreach(var q in new[]{new Vector2(-14,16),new Vector2(30,22),new Vector2(48,-14),new Vector2(-6,-24)})Plant(rock,q.x,q.y,q.x);
  var tree=await Model("Resource_Tree1",3);tree.SetActive(false);
  var tree2=await Model("Resource_Tree2",3.2f);tree2.SetActive(false);
  var pine=await Model("Resource_PineTree",3);pine.SetActive(false);
  int plantedTrees=0;
  for(int i=0;i<420&&plantedTrees<310;i++){float x=(float)Math.Sin(i*127.1)*75+22,z=(float)Math.Sin(i*311.7)*78;if(x<Coast(z)+5||(x>-14&&x<50&&Mathf.Abs(z)<26))continue;var tpl=Hash(i,7)<.4f?pine:(Hash(i,8)<.5f?tree:tree2);var before=swayers.Count;PlantSway(tpl,x,z,i);plantedTrees++;}
  for(int i=0;i<26;i++){var p=GameObject.CreatePrimitive(PrimitiveType.Cube);p.transform.position=new Vector3(-24+i*.4f,.35f,-12);p.transform.localScale=new Vector3(.38f,.16f,2.5f);var m=new Material(Shader.Find("Universal Render Pipeline/Lit"));m.color=new Color(.32f,.24f,.14f);p.GetComponent<Renderer>().material=m;}
  try{var boat=await ModelFile("boat-sail-a.glb",4);boat.transform.position=new Vector3(Coast(-18)-7,.05f,-(-18));boat.transform.rotation=Quaternion.Euler(0,40,0);boats.Add(boat.transform);}catch(Exception e){Debug.LogWarning("boat: "+e.Message);}
  try{var ship=await ModelFile("boat-fishing-small.glb",5);ship.transform.position=new Vector3(Coast(24)-14,.05f,-24);ship.transform.rotation=Quaternion.Euler(0,-25,0);boats.Add(ship.transform);}catch(Exception e){Debug.LogWarning("ship: "+e.Message);}
  try{var horse=await Model("Horse",2.2f);horse.SetActive(false);Plant(horse,23,9,.8f);Plant(horse,28,-5f,2.1f);var cow=await Model("Cow",2.2f);cow.SetActive(false);Plant(cow,26,12,1.4f);Plant(cow,35,4,.3f);}catch(Exception e){Debug.LogWarning("animals: "+e.Message);}
  try{Smoke(new Vector3(-4,3.1f,-4));Smoke(new Vector3(14,3.3f,5));Smoke(new Vector3(36,3.1f,2));Motes();}catch(Exception e){Debug.LogWarning("particles: "+e.Message);}
 }
 void PlantSway(GameObject template,float x,float z,float turn=0){var o=Instantiate(template);o.SetActive(true);o.transform.position=new Vector3(x,Height(x,z),-z);o.transform.rotation=Quaternion.Euler(0,-turn*Mathf.Rad2Deg,0);swayers.Add(o.transform);swayPhase.Add(Hash((int)(x*10+z),3)*6.28f);}
 Texture2D DotTex(){var t=new Texture2D(32,32);for(int y=0;y<32;y++)for(int x=0;x<32;x++){float d=Vector2.Distance(new Vector2(x,y),new Vector2(15.5f,15.5f))/16f;t.SetPixel(x,y,new Color(1,1,1,Mathf.Clamp01(1-d)));}t.Apply();return t;}
 void Smoke(Vector3 at){var go=new GameObject("Chimney smoke");go.transform.position=at;var ps=go.AddComponent<ParticleSystem>();var main=ps.main;main.startLifetime=4.5f;main.startSpeed=.55f;main.startSize=.55f;main.startColor=new Color(.75f,.76f,.78f,.35f);main.maxParticles=42;main.simulationSpace=ParticleSystemSimulationSpace.World;var em=ps.emission;em.rateOverTime=7;var sh=ps.shape;sh.shapeType=ParticleSystemShapeType.Sphere;sh.radius=.18f;var vel=ps.velocityOverLifetime;vel.enabled=true;vel.x=new ParticleSystem.MinMaxCurve(.22f);vel.z=new ParticleSystem.MinMaxCurve(-.12f);var sz=ps.sizeOverLifetime;sz.enabled=true;sz.size=new ParticleSystem.MinMaxCurve(1,new AnimationCurve(new Keyframe(0,.35f),new Keyframe(1,2.2f)));var col=ps.colorOverLifetime;col.enabled=true;var g=new Gradient();g.SetKeys(new[]{new GradientColorKey(Color.white,0),new GradientColorKey(Color.white,1)},new[]{new GradientAlphaKey(.32f,0),new GradientAlphaKey(.2f,.5f),new GradientAlphaKey(0,1)});col.color=g;var r=go.GetComponent<ParticleSystemRenderer>();var m=new Material(Shader.Find("Prototype/SoftParticle"));m.SetTexture("_BaseMap",DotTex());m.SetColor("_BaseColor",new Color(.78f,.79f,.81f,.5f));r.material=m;r.renderMode=ParticleSystemRenderMode.Billboard;}
 void Motes(){var go=new GameObject("Drifting motes");go.transform.position=new Vector3(14,4,0);var ps=go.AddComponent<ParticleSystem>();var main=ps.main;main.startLifetime=9;main.startSpeed=.35f;main.startSize=.09f;main.startColor=new Color(1,.95f,.82f,.5f);main.maxParticles=260;main.simulationSpace=ParticleSystemSimulationSpace.World;var em=ps.emission;em.rateOverTime=26;var sh=ps.shape;sh.shapeType=ParticleSystemShapeType.Box;sh.scale=new Vector3(90,7,60);var r=go.GetComponent<ParticleSystemRenderer>();var m=new Material(Shader.Find("Prototype/SoftParticle"));m.SetTexture("_BaseMap",DotTex());m.SetColor("_BaseColor",new Color(1,.95f,.82f,.45f));r.material=m;}
 void Connect(){reader=new Thread(()=>{try{socket=new TcpClient("127.0.0.1",4188);socket.NoDelay=true;writer=new StreamWriter(socket.GetStream()){AutoFlush=true};var stream=new StreamReader(socket.GetStream());while(!stop){var line=stream.ReadLine();if(line==null)break;incoming=line;}}catch(Exception e){Debug.LogWarning(e.Message);}});reader.IsBackground=true;reader.Start();}
 void Order(string kind){if(writer==null)return;writer.WriteLine(JsonUtility.ToJson(new SimOrder{kind=kind,seq=++seq}));}
 void SetView(int n){view=(n+3)%3;cameraRig.orthographic=view==0;cameraRig.orthographicSize=27.5f;cameraRig.fieldOfView=44;
  cameraRig.transform.position=view==0?new Vector3(4,66,-46):view==1?new Vector3(35,25,-39):new Vector3(-54,43,-61);
  target=view==0?new Vector3(4,0,0):view==1?new Vector3(5,1,-1):new Vector3(-4,0,8);cameraRig.transform.LookAt(target);
 }
 void Update(){
  if(!cameraRig)return;elapsed+=Time.unscaledDeltaTime;if(elapsed>3)frameTimes.Add(Time.unscaledDeltaTime*1000);
  var line=Interlocked.Exchange(ref incoming,null);if(line!=null){var frame=JsonUtility.FromJson<SimFrame>(line);if(frame!=null&&frame.schema=="hybrid-v1"){previous=latest;latest=frame;liveTick=frame.tick;receivedAt=Time.unscaledTime;}}
  if(reference!=null){latest=reference;previous=reference;}
  if(Input.GetKeyDown(KeyCode.LeftArrow))SetView(view-1);if(Input.GetKeyDown(KeyCode.RightArrow))SetView(view+1);if(Input.GetKeyDown(KeyCode.R))SetView(view);
  float wheel=Input.mouseScrollDelta.y;if(wheel!=0){if(cameraRig.orthographic)cameraRig.orthographicSize=Mathf.Clamp(cameraRig.orthographicSize*Mathf.Exp(-wheel*.1f),9,50);else cameraRig.transform.position=target+(cameraRig.transform.position-target)*Mathf.Exp(-wheel*.1f);}
  if(Input.GetMouseButton(1)){var offset=(-cameraRig.transform.right*Input.GetAxis("Mouse X")-cameraRig.transform.up*Input.GetAxis("Mouse Y"))*.3f;cameraRig.transform.position+=offset;target+=offset;}
  if(Input.GetMouseButton(0)&&Input.mousePosition.y<Screen.height-240){cameraRig.transform.RotateAround(target,Vector3.up,Input.GetAxis("Mouse X")*2);}
  if(latest!=null&&popMesh&&capsuleMats!=null){
   int heroTarget=heroTemplates!=null&&heroTemplates.Count>0?Mathf.Min(HEROES,latest.pops.Length):0;
   if(heroes.Count!=heroTarget||popObjects.Count!=latest.pops.Length-heroTarget){
    foreach(var old in heroes)Destroy(old.gameObject);heroes.Clear();heroAnims.Clear();heroState.Clear();
    foreach(var old in popObjects)Destroy(old.gameObject);popObjects.Clear();
    for(int i=0;i<heroTarget;i++){var go=Instantiate(heroTemplates[i%heroTemplates.Count]);go.SetActive(true);float sc=.92f+Hash(i,5)*.16f;go.transform.localScale*=sc;heroes.Add(go.transform);var an=go.GetComponentInChildren<Animation>(true);heroAnims.Add(an);heroState.Add("");
     if(an!=null){an.cullingType=AnimationCullingType.BasedOnRenderers;foreach(AnimationState st in an){st.wrapMode=WrapMode.Loop;}}}
    for(int i=heroTarget;i<latest.pops.Length;i++){var go=new GameObject("Pop "+i);go.AddComponent<MeshFilter>().sharedMesh=popMesh;go.AddComponent<MeshRenderer>().sharedMaterial=capsuleMats[i%6];float sc=.92f+Hash(i,5)*.16f;go.transform.localScale=new Vector3(.38f*sc,.4f*sc,.38f*sc);popObjects.Add(go.transform);}
   }
   float alpha=Mathf.Clamp01((Time.unscaledTime-receivedAt)/.033f);float now=Time.time;
   for(int i=0;i<latest.pops.Length;i++){var p=latest.pops[i];float x=p.x/1000f,z=p.z/1000f,px=x,pz=z;
    if(previous!=null&&previous.pops.Length==latest.pops.Length){px=previous.pops[i].x/1000f;pz=previous.pops[i].z/1000f;x=Mathf.Lerp(px,x,alpha);z=Mathf.Lerp(pz,z,alpha);}
    float vx=p.x/1000f-px,vz=p.z/1000f-pz;float speed=Mathf.Sqrt(vx*vx+vz*vz)*30f;
    if(speed>.15f){float targetYaw=Mathf.Atan2(vx,-vz)*Mathf.Rad2Deg;yaw[i]=Mathf.LerpAngle(yaw[i],targetYaw,1-Mathf.Exp(-10f*Time.deltaTime));}
    float bob=speed>.15f?Mathf.Abs(Mathf.Sin(now*9f+Hash(i,9)*6.28f))*.07f:Mathf.Sin(now*1.7f+Hash(i,9)*6.28f)*.015f;
    if(i<heroes.Count){var tr=heroes[i];tr.position=new Vector3(x,Height(x,z)+bob,-z);tr.rotation=Quaternion.Euler(0,yaw[i],0);
     var an=heroAnims[i];if(an!=null){string want=speed>2.2f?"Running_A":speed>.15f?"Walking_A":"Idle";if(heroState[i]!=want){var st=an[want];if(st!=null){heroState[i]=want;an.CrossFade(want,.18f);if(an[want]!=null)an[want].time=Hash(i,11)*an[want].length;}}}}
    else{var tr=popObjects[i-heroes.Count];tr.position=new Vector3(x,Height(x,z)+.5f+bob,-z);tr.rotation=Quaternion.Euler(Mathf.Clamp(speed*.7f,0,7),yaw[i],0);}
   }
  }
  for(int b=0;b<boats.Count;b++){var t=boats[b];if(!t)continue;var pos=t.position;pos.y=.02f+Mathf.Sin(Time.time*.8f+b*1.7f)*.07f;t.position=pos;t.rotation=Quaternion.Euler(Mathf.Sin(Time.time*.6f+b)*1.6f,t.rotation.eulerAngles.y,Mathf.Sin(Time.time*.5f+b*2.1f)*1.2f);}
  for(int t2=0;t2<swayers.Count;t2++){var tr=swayers[t2];if(!tr)continue;var e=tr.rotation.eulerAngles;tr.rotation=Quaternion.Euler(Mathf.Sin(Time.time*1.1f+swayPhase[t2])*1.1f,e.y,Mathf.Cos(Time.time*.9f+swayPhase[t2])*.8f);}
  if(!captured&&latest!=null&&elapsed>12&&capturePath!=""){captured=true;var previousTarget=RenderTexture.active;RenderTexture.active=renderTarget;var image=new Texture2D(1600,1000,TextureFormat.RGB24,false);image.ReadPixels(new Rect(0,0,1600,1000),0,0);image.Apply();File.WriteAllBytes(capturePath,image.EncodeToPNG());Destroy(image);RenderTexture.active=previousTarget;frameTimes.Sort();File.WriteAllText(capturePath+".json",JsonUtility.ToJson(new CaptureStats{view=view,pops=latest.pops.Length,frames=frameTimes.Count,tick=latest.tick,live_tick=liveTick,digest=latest.digest,p50_frame_ms=frameTimes[frameTimes.Count/2],p95_frame_ms=frameTimes[(int)(frameTimes.Count*.95)],gpu=SystemInfo.graphicsDeviceName,api=SystemInfo.graphicsDeviceType.ToString()},true));Debug.Log("HYBRID_EVIDENCE Unity view="+view+" p50_ms="+frameTimes[frameTimes.Count/2]+" p95_ms="+frameTimes[(int)(frameTimes.Count*.95)]+" tick="+latest?.tick);Invoke(nameof(FinishCapture),1);}
 }
 void FinishCapture(){Application.Quit();}
 void OnGUI(){if(!cameraRig)return;if(renderTarget)GUI.DrawTexture(new Rect(0,0,Screen.width,Screen.height),renderTarget,ScaleMode.ScaleToFit,false);GUI.Box(new Rect(20,20,420,240),"");GUILayout.BeginArea(new Rect(32,30,395,225));GUILayout.Label("AGEOFWIND · UNITY URP + RUST\n"+names[view]);
  if(latest!=null)GUILayout.Label($"Tick {latest.tick} · Pops {latest.pops.Length} · workers {latest.workers}\nThreads observed {latest.threads_observed} · sim {latest.sim_ms:F3} ms\nStock {latest.stock} · ack {latest.ack}\nDigest {latest.digest}");else GUILayout.Label("Connecting to Rust…");
  GUILayout.BeginHorizontal();for(int i=0;i<3;i++)if(GUILayout.Button(new[]{"A Tactical","B Settlement","C Panorama"}[i]))SetView(i);GUILayout.EndHorizontal();
  GUILayout.BeginHorizontal();if(GUILayout.Button("Move group"))Order("move");if(GUILayout.Button("Resume work"))Order("work");if(GUILayout.Button("Pause"))Order("pause");GUILayout.EndHorizontal();
  GUILayout.Label("Arrows: views · R: reset · wheel: zoom\nLive movement/needs/deliveries slice; not full RTS");GUILayout.EndArea();}
 void OnDestroy(){stop=true;socket?.Close();}
}
