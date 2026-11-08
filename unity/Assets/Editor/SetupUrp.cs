using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>One-time URP wiring for the production project (#186):
/// Unity -batchmode -quit -projectPath unity -executeMethod SetupUrp.Run
/// Creates the pipeline asset + renderer if missing, assigns them in
/// GraphicsSettings and every quality level, and pins the shaders that
/// SkeletonMain finds by name at runtime into Always Included Shaders.</summary>
public static class SetupUrp
{
    const string Dir = "Assets/Rendering";
    const string AssetPath = Dir + "/URPAsset.asset";
    const string RendererPath = Dir + "/URPRenderer.asset";

    public static void Run()
    {
        Directory.CreateDirectory(Dir);
        var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(RendererPath);
        if (!renderer)
        {
            renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(renderer, RendererPath);
        }
        var asset = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(AssetPath);
        if (!asset)
        {
            asset = UniversalRenderPipelineAsset.Create(renderer);
            AssetDatabase.CreateAsset(asset, AssetPath);
        }
        GraphicsSettings.defaultRenderPipeline = asset;
        for (int i = 0; i < QualitySettings.names.Length; i++)
        {
            QualitySettings.SetQualityLevel(i, false);
            QualitySettings.renderPipeline = asset;
        }

        var graphics = AssetDatabase.LoadAssetAtPath<Object>("ProjectSettings/GraphicsSettings.asset");
        var so = new SerializedObject(graphics);
        var included = so.FindProperty("m_AlwaysIncludedShaders");
        void Include(Shader shader)
        {
            if (!shader) return;
            for (int i = 0; i < included.arraySize; i++)
                if (included.GetArrayElementAtIndex(i).objectReferenceValue == shader) return;
            included.InsertArrayElementAtIndex(included.arraySize);
            included.GetArrayElementAtIndex(included.arraySize - 1).objectReferenceValue = shader;
        }
        foreach (var name in new[] { "Prototype/Terrain", "Prototype/Water", "Prototype/SoftParticle", "Universal Render Pipeline/Lit" })
        {
            var shader = Shader.Find(name);
            if (!shader) { Debug.LogWarning($"[SetupUrp] shader not found: {name}"); continue; }
            Include(shader);
        }
        // glTFast loads materials at runtime; its shaders must survive player stripping.
        int gltfCount = 0;
        foreach (var guid in AssetDatabase.FindAssets("t:Shader", new[] { "Packages/com.unity.cloud.gltfast" }))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var shader = AssetDatabase.LoadAssetAtPath<Shader>(path);
            if (shader) { Include(shader); gltfCount++; }
        }
        Debug.Log($"[SetupUrp] glTFast shaders included: {gltfCount}");
        so.ApplyModifiedProperties();
        AssetDatabase.SaveAssets();
        Debug.Log($"[SetupUrp] pipeline assigned: {AssetPath}");
    }
}
