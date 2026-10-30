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
  float ripple=sin(i.w.x*.32+i.w.z*.41+_Time.y*.7)*.5+.5;
  float ripple2=sin(i.w.x*.11-i.w.z*.17+_Time.y*.43)*.5+.5;
  float3 deep=float3(.055,.22,.30);float3 shallow=float3(.30,.55,.53);
  float3 sea=lerp(deep,shallow,smoothstep(-26,1.5,d));
  sea*= .94+ripple*.045+ripple2*.035;
  float foam=smoothstep(-.4,.9,d)*(0.55+0.30*sin(d*3.1-_Time.y*1.1))*(1.0-smoothstep(.9,2.2,d));
  float3 col=lerp(sea,float3(.92,.95,.87),saturate(foam)*.8);
  float fog=saturate((distance(_WorldSpaceCameraPos,i.w)-90.0)/260.0);
  return half4(lerp(col,float3(.55,.64,.67),fog*fog*.85),1);
 }
 ENDHLSL
 }}
}
