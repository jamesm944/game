Shader "Prototype/Water" {
 SubShader{Tags{"RenderType"="Opaque" "RenderPipeline"="UniversalPipeline"}
 Pass{Tags{"LightMode"="UniversalForward"}
 HLSLPROGRAM
 #pragma vertex vert
 #pragma fragment frag
 #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
 struct A{float4 p:POSITION;};struct V{float4 p:SV_POSITION;float3 w:TEXCOORD0;};
 V vert(A i){V o;o.w=TransformObjectToWorld(i.p.xyz);o.p=TransformWorldToHClip(o.w);return o;}
 half4 frag(V i):SV_Target{
  float d=i.w.x+18-sin(-i.w.z*.1)*4-sin(-i.w.z*.27)*1.4;
  float ripple=sin(i.w.x*1.7+i.w.z*2.3+_Time.y*1.3)*.5+.5;
  float3 sea=lerp(float3(.014,.082,.117),float3(.147,.417,.352),smoothstep(-14,1,d));
  return half4(lerp(sea*(.93+ripple*.07),float3(.70,.78,.62),smoothstep(.25,1.25,d)*(.5+ripple*.35)),1);
 }
 ENDHLSL
 }}
}
