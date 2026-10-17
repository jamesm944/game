Shader "Prototype/Terrain" {
 Properties{_Grass("Grass",2D)="white"{} }
 SubShader{Tags{"RenderType"="Opaque" "RenderPipeline"="UniversalPipeline"}
 Pass{Tags{"LightMode"="UniversalForward"}
 HLSLPROGRAM
 #pragma vertex vert
 #pragma fragment frag
 #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
 #pragma multi_compile_fragment _ _SHADOWS_SOFT
 #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
 #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
 struct Attributes{float4 positionOS:POSITION;float3 normalOS:NORMAL;float4 color:COLOR;};
 struct Varyings{float4 positionCS:SV_POSITION;float3 world:TEXCOORD0;float3 normal:TEXCOORD1;float3 color:TEXCOORD2;};
 TEXTURE2D(_Grass);SAMPLER(sampler_Grass);
 Varyings vert(Attributes i){Varyings o;o.world=TransformObjectToWorld(i.positionOS.xyz);o.positionCS=TransformWorldToHClip(o.world);o.normal=TransformObjectToWorldNormal(i.normalOS);o.color=i.color.rgb;return o;}
 half4 frag(Varyings i):SV_Target {
  float d=i.world.x+18-sin(-i.world.z*.1)*4-sin(-i.world.z*.27)*1.4;
  float3 grass=SAMPLE_TEXTURE2D(_Grass,sampler_Grass,i.world.xz*.28).rgb*i.color;
  float3 albedo=lerp(float3(.60,.47,.29),grass,smoothstep(1,5,d));
  Light light=GetMainLight(TransformWorldToShadowCoord(i.world));
  float ndl=saturate(dot(normalize(i.normal),light.direction));
  return half4(albedo*(SampleSH(normalize(i.normal))+light.color*ndl*light.shadowAttenuation),1);
 }
 ENDHLSL
 }}
}
