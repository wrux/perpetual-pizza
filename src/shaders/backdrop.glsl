#version 300 es
precision highp float;
uniform sampler2D tDiffuse;
in vec2 vUv;
layout( location = 0 ) out vec4 oColor;
layout( location = 1 ) out vec4 oNormal;
#include <display>
void main() {
  oColor = vec4( display( texture( tDiffuse, vUv ).rgb ), 1.0 );
  oNormal = vec4( 0.5, 0.5, 1.0, 1.0 );
}
