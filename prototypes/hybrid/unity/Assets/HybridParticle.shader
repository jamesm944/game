Shader "Prototype/SoftParticle" {
 Properties{_BaseMap("Map",2D)="white"{} _BaseColor("Color",Color)=(1,1,1,1)}
 SubShader{Tags{"RenderType"="Transparent" "Queue"="Transparent" "RenderPipeline"="UniversalPipeline"}
 Blend SrcAlpha OneMinusSrcAlpha
 ZWrite Off
 Pass{Tags{"LightMode"="UniversalForward"}
 HLSLPROGRAM
 #pragma vertex vert
 #pragma fragment frag
 #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
 struct A{float4 p:POSITION;float4 c:COLOR;float2 uv:TEXCOORD0;};
 struct V{float4 p:SV_POSITION;float4 c:COLOR;float2 uv:TEXCOORD0;};
 TEXTURE2D(_BaseMap);SAMPLER(sampler_BaseMap);float4 _BaseColor;
 V vert(A i){V o;o.p=TransformObjectToHClip(i.p.xyz);o.c=i.c;o.uv=i.uv;return o;}
 half4 frag(V i):SV_Target{return SAMPLE_TEXTURE2D(_BaseMap,sampler_BaseMap,i.uv)*_BaseColor*i.c;}
 ENDHLSL
 }}
}
