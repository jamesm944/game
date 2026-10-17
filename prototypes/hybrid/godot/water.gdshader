shader_type spatial;
render_mode depth_draw_opaque;
varying vec3 world_pos;
void vertex(){world_pos=(MODEL_MATRIX*vec4(VERTEX,1.0)).xyz;}
void fragment(){
 float d=world_pos.x+18.0-sin(world_pos.z*.10)*4.0-sin(world_pos.z*.27)*1.4;
 float ripple=sin(world_pos.x*1.7+world_pos.z*2.3+TIME*1.3)*.5+.5;
 vec3 sea=mix(vec3(.014,.082,.117),vec3(.147,.417,.352),smoothstep(-14.0,1.0,d));
 ALBEDO=mix(sea*(.93+ripple*.07),vec3(.70,.78,.62),smoothstep(.25,1.25,d)*(.5+ripple*.35));
 ROUGHNESS=.25;METALLIC=.22;
}
