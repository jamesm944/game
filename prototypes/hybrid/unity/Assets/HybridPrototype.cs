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
 Mesh popMesh;Material popMaterial,redMaterial;List<Transform> popObjects=new();long liveTick;
 string[] names={"A · Commander's view","B · Life in the settlement","C · Coastal frontier"};
 List<float> frameTimes=new();float elapsed;bool captured;string capturePath="";
 float Coast(float z)=>-18+Mathf.Sin(z*.1f)*4+Mathf.Sin(z*.27f)*1.4f;
 float Height(float x,float z){float d=x-Coast(z);if(d<0)return Mathf.Max(-5,d*.19f-.14f);float hills=Mathf.Max(0,new Vector2(x*.8f,z).magnitude-25);return -.14f+Mathf.Min(d,7)*.11f+hills*.08f*(1+.45f*Mathf.Sin(z*.13f+x*.07f));}
 async void Start(){
  Application.runInBackground=true;Application.targetFrameRate=120;QualitySettings.vSyncCount=0;
  var args=Environment.GetCommandLineArgs();int initial=0;
  foreach(var a in args){if(a.StartsWith("--view="))initial=int.Parse(a.Substring(7));if(a.StartsWith("--capture="))capturePath=a.Substring(10);}
  cameraRig=new GameObject("Camera").AddComponent<Camera>();cameraRig.nearClipPlane=.1f;cameraRig.farClipPlane=700;cameraRig.backgroundColor=new Color(.66f,.75f,.77f);cameraRig.clearFlags=CameraClearFlags.SolidColor;
  renderTarget=new RenderTexture(1600,1000,24,RenderTextureFormat.ARGB32,RenderTextureReadWrite.sRGB);renderTarget.antiAliasing=4;renderTarget.Create();cameraRig.targetTexture=renderTarget;
  RenderSettings.ambientMode=UnityEngine.Rendering.AmbientMode.Flat;RenderSettings.ambientLight=new Color(.62f,.70f,.72f);
  RenderSettings.fog=true;RenderSettings.fogMode=FogMode.Linear;RenderSettings.fogColor=new Color(.66f,.75f,.77f);RenderSettings.fogStartDistance=90;RenderSettings.fogEndDistance=350;
  var sun=new GameObject("Sun").AddComponent<Light>();sun.type=LightType.Directional;sun.intensity=1.5f;sun.color=new Color(1,.94f,.82f);sun.transform.rotation=Quaternion.LookRotation(new Vector3(25,-65,35));sun.shadows=LightShadows.Soft;
  Terrain();Water();SetView(initial);
  var capsule=GameObject.CreatePrimitive(PrimitiveType.Capsule);popMesh=Instantiate(capsule.GetComponent<MeshFilter>().sharedMesh);Destroy(capsule);
  popMaterial=new Material(Shader.Find("Universal Render Pipeline/Lit"));popMaterial.color=new Color(.05f,.16f,.34f);popMaterial.enableInstancing=true;redMaterial=new Material(popMaterial);redMaterial.color=new Color(.4f,.1f,.04f);
  await Village();if(capturePath!="")reference=JsonUtility.FromJson<SimFrame>(File.ReadAllText(Path.Combine(Application.streamingAssetsPath,"Imported/frozen-frame.json")));Connect();
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
  foreach(var p in new[]{new Vector2(-4,4),new Vector2(3,8),new Vector2(12,6),new Vector2(14,-5),new Vector2(3,-13),new Vector2(-6,-8),new Vector2(14,-15),new Vector2(22,4)})Plant(house,p.x,p.y,.25f*p.x);
  var mill=await Model("Windmill_FirstAge",4);mill.SetActive(false);Plant(mill,22,-11);
  var farm=await Model("Farm_FirstAge_Level1_Wheat",5);farm.SetActive(false);foreach(var p in new[]{new Vector2(24,-2),new Vector2(25,5),new Vector2(32,0),new Vector2(32,7)})Plant(farm,p.x,p.y);
  var tree=await Model("Resource_Tree1",3);tree.SetActive(false);
  for(int i=0;i<190;i++){float x=(float)Math.Sin(i*127.1)*65+19,z=(float)Math.Sin(i*311.7)*70;if(x<Coast(z)+5||(x>-12&&x<37&&Mathf.Abs(z)<23))continue;Plant(tree,x,z,i);}
  for(int i=0;i<22;i++){var p=GameObject.CreatePrimitive(PrimitiveType.Cube);p.transform.position=new Vector3(-24+i*.4f,.35f,-12);p.transform.localScale=new Vector3(.38f,.16f,2.5f);var m=new Material(Shader.Find("Universal Render Pipeline/Lit"));m.color=new Color(.4f,.3f,.18f);p.GetComponent<Renderer>().material=m;}
 }
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
  if(latest!=null&&popMesh&&popMaterial){
   // NOTE: RenderMeshInstanced drew nothing in the player build (runtime-created Lit
   // material: instancing shader variant stripped). Pooled MeshRenderers + SRP Batcher
   // measured the same p95 at 500 Pops; keep the proven path.
   popMaterial.enableInstancing=false;redMaterial.enableInstancing=false;
   if(popObjects.Count!=latest.pops.Length){foreach(var old in popObjects)Destroy(old.gameObject);popObjects.Clear();for(int i=0;i<latest.pops.Length;i++){var go=new GameObject("Pop "+i);go.AddComponent<MeshFilter>().sharedMesh=popMesh;go.AddComponent<MeshRenderer>().sharedMaterial=i%3==0?redMaterial:popMaterial;go.transform.localScale=new Vector3(.38f,.4f,.38f);popObjects.Add(go.transform);}}
   float alpha=Mathf.Clamp01((Time.unscaledTime-receivedAt)/.033f);
   for(int i=0;i<latest.pops.Length;i++){var p=latest.pops[i];float x=p.x/1000f,z=p.z/1000f;if(previous!=null&&previous.pops.Length==latest.pops.Length){x=Mathf.Lerp(previous.pops[i].x/1000f,x,alpha);z=Mathf.Lerp(previous.pops[i].z/1000f,z,alpha);}
    popObjects[i].position=new Vector3(x,Height(x,z)+.5f,-z);
   }
  }
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
