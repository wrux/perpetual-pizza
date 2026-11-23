#version 300 es
layout( location = 0 ) in vec3 aPosition;
layout( location = 1 ) in vec3 aNormal;
layout( location = 2 ) in vec2 aUv;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uViewProjection;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out float vDepth;
void main() {
  vec4 world = uModel * vec4( aPosition, 1.0 );
  vWorld = world.xyz;
  vNormal = mat3( uModel ) * aNormal;
  vUv = aUv;
  vDepth = - ( uView * world ).z;
  gl_Position = uViewProjection * world;
}
