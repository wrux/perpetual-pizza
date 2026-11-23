#version 300 es
/** Opening lines that let a fragment shader written for WebGL1 run as is. */
precision highp float;
#define varying in
#define texture2D texture
#define gl_FragColor fragColor
out vec4 fragColor;
