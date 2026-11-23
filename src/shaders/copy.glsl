/** Copies a picture unchanged. */
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }
