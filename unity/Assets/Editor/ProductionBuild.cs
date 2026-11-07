using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>Headless production builds (#185). One command builds Mac + Windows:
/// Unity -batchmode -quit -projectPath unity -executeMethod ProductionBuild.BuildAll</summary>
public static class ProductionBuild
{
    const string ScenePath = "Assets/Main.unity";

    static void EnsureScene()
    {
        if (File.Exists(ScenePath)) return;
        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        EditorSceneManager.SaveScene(scene, ScenePath);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
    }

    static bool Build(BuildTarget target, string outPath, BuildOptions options = BuildOptions.None)
    {
        var opts = new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            locationPathName = outPath,
            target = target,
            options = options,
        };
        var report = BuildPipeline.BuildPlayer(opts);
        Debug.Log($"[ProductionBuild] {target} -> {report.summary.result} errors={report.summary.totalErrors} size={report.summary.totalSize} out={outPath}");
        return report.summary.result == BuildResult.Succeeded;
    }

    public static void BuildAll()
    {
        EnsureScene();
        PlayerSettings.productName = "Ageofwind";
        PlayerSettings.companyName = "Ageofwind";
        var okMac = Build(BuildTarget.StandaloneOSX, "build/macos/Ageofwind.app");
        // Mono backend is the supported Windows cross-build from macOS hosts.
        PlayerSettings.SetScriptingBackend(NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);
        var okWin = Build(BuildTarget.StandaloneWindows64, "build/windows/Ageofwind.exe");
        if (!okMac || !okWin) EditorApplication.Exit(1);
    }
}
