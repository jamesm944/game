shader_type spatial;
varying vec3 world_pos;
uniform sampler2D grass_texture : source_color, repeat_enable, filter_linear_mipmap_anisotropic;
void vertex(){world_pos=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;}
void fragment(){
 float d=world_pos.x+18.0-sin(world_pos.z*.10)*4.0-sin(world_pos.z*.27)*1.4;
 vec3 grass=texture(grass_texture,world_pos.xz*.28).rgb * COLOR.rgb;
 ALBEDO=mix(vec3(.60,.47,.29),grass,smoothstep(1.0,5.0,d));
 ROUGHNESS=.96;
}
