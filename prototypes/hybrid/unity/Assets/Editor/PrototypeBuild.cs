// THROWAWAY scene generator + native build entry, run -executeMethod PrototypeBuild.Build.
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
public static class PrototypeBuild {
 public static void Prepare() {
  var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>("Assets/PrototypeRenderer.asset") ?? ScriptableObject.CreateInstance<UniversalRendererData>();
  if(!AssetDatabase.Contains(renderer))AssetDatabase.CreateAsset(renderer,"Assets/PrototypeRenderer.asset");
  var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>("Assets/PrototypePipeline.asset") ?? ScriptableObject.CreateInstance<UniversalRenderPipelineAsset>();
  var serialized = new SerializedObject(pipeline);
  var renderers = serialized.FindProperty("m_RendererDataList");
  renderers.arraySize=1;renderers.GetArrayElementAtIndex(0).objectReferenceValue=renderer;
  serialized.ApplyModifiedPropertiesWithoutUndo();
  if(!AssetDatabase.Contains(pipeline))AssetDatabase.CreateAsset(pipeline,"Assets/PrototypePipeline.asset");
  GraphicsSettings.defaultRenderPipeline=pipeline;QualitySettings.renderPipeline=pipeline;
  QualitySettings.shadows=UnityEngine.ShadowQuality.All;QualitySettings.shadowDistance=120;
  PlayerSettings.colorSpace=ColorSpace.Linear;
  PlayerSettings.defaultScreenWidth=1600;PlayerSettings.defaultScreenHeight=1000;
  PlayerSettings.fullScreenMode=FullScreenMode.Windowed;
  PlayerSettings.companyName="Ageofwind prototype";PlayerSettings.productName="Ageofwind Unity + Rust prototype";
  var scene=EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
  new GameObject("Hybrid prototype").AddComponent<HybridPrototype>();
  EditorSceneManager.SaveScene(scene,"Assets/Prototype.unity");
  var settings = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset")[0]);
  var included = settings.FindProperty("m_AlwaysIncludedShaders");
  foreach(var info in ShaderUtil.GetAllShaderInfo()) {
   if(info.name.StartsWith("Prototype/") || info.name.StartsWith("Shader Graphs/glTF-") || info.name=="Universal Render Pipeline/Lit") {
    var shader=Shader.Find(info.name);bool found=false;
    for(int i=0;i<included.arraySize;i++)if(included.GetArrayElementAtIndex(i).objectReferenceValue==shader)found=true;
    if(!found){int i=included.arraySize;included.InsertArrayElementAtIndex(i);included.GetArrayElementAtIndex(i).objectReferenceValue=shader;}
   }
  }
  settings.ApplyModifiedPropertiesWithoutUndo();
  AssetDatabase.SaveAssets();
 }
 public static void Build() {
  Prepare();
  var report=BuildPipeline.BuildPlayer(new[]{"Assets/Prototype.unity"},"../build/UnityHybrid.app",BuildTarget.StandaloneOSX,BuildOptions.None);
  if(report.summary.result!=UnityEditor.Build.Reporting.BuildResult.Succeeded)throw new System.Exception(report.summary.result.ToString());
 }
}
