/**
 * Draws the pizza: one physically based material, a key light with a shadow,
 * a fill light, sky light and studio reflections, fog and a filmic tone curve.
 * Everything comes out display-ready, so the default look needs no second pass.
 */

import {
  bindTarget,
  createPixel,
  createProgram,
  createTexture,
  lookAt,
  multiply,
  normalize,
  orthographic,
  resolveTarget,
  SCREEN_VERTEX,
  type Geometry,
  type GL,
  type Mat4,
  type Target,
  type Vec3,
} from './gl';

/** A '#rrggbb' colour as linear light, which is what the lighting works in. */
export function srgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return [linear(((n >> 16) & 255) / 255), linear(((n >> 8) & 255) / 255), linear((n & 255) / 255)];
}

export interface Grain {
  /** How many times the grain tiles across the material's UVs, along u and v. */
  repeat: [number, number];
  /** Strength of the colour and roughness variation. */
  tint: number;
  /** Strength of the relief. */
  bump: number;
}

export interface Material {
  map?: WebGLTexture | null;
  /** Multiplies the map, in linear light. */
  color?: Vec3;
  normalMap?: WebGLTexture | null;
  normalScale?: number;
  roughMap?: WebGLTexture | null;
  rough?: number;
  /** A thin glossy coat over the surface, 0 to 1. */
  clearcoat?: number;
  /** Fine tiling grain layered over the colour, roughness and normals. */
  grain?: Grain;
  /** A close-up photo of melted cheese, laid over the parts of the map that are cheese-coloured. */
  cheese?: WebGLTexture | null;
  side?: 'front' | 'back' | 'both';
  casts?: boolean;
  receives?: boolean;
}

export interface Mesh {
  material: Material;
  vao: WebGLVertexArrayObject;
  count: number;
  free(): void;
}

export interface Item {
  mesh: Mesh;
  matrix: Mat4;
}

export interface View {
  projection: Mat4;
  view: Mat4;
  eye: Vec3;
}

export interface RenderOptions {
  shadows?: boolean;
  /** Draw on an empty, unfogged stage with a clear background, for thumbnails. */
  stage?: boolean;
}

/* Lights. Colours are in linear light with their brightness multiplied in. */
const times = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
// Key light from behind and to the side, low enough to rake across the
// surface: it picks out every bubble and glints off the grease.
const SUN_AT: Vec3 = [-3.2, 3.1, -2.4];
const SUN = times(srgb('#ffe9cc'), 2.1);
const FILL_FROM = normalize([2.5, 2.5, 3]);
const FILL = times(srgb('#ffe2c4'), 0.55);
const SKY = times(srgb('#fff1dc'), 0.4);
const GROUND = times(srgb('#a8571a'), 0.4);
/** Fog in the backdrop's glow, so the far edge of the biggest pizza melts into it. */
const FOG = srgb('#5a2c12');
const FOG_NEAR = 3.5;
const FOG_FAR = 12;
/** How bright the studio reflections are overall. */
const ENVIRONMENT = 0.35;
const EXPOSURE = 0.82;

const SHADOW_SIZE = 2048;
/** Half the width of the square of ground the shadow map covers. */
const SHADOW_REACH = 2.5;

/** The reflections image: this many blur levels stacked top to bottom, sharpest first. */
const ENV_LEVELS = 7;
const ENV_WIDTH = 64;
const ENV_HEIGHT = 32;

const vec3 = (v: Vec3) => `vec3( ${v.map((x) => x.toFixed(5)).join(', ')} )`;

/** Filmic tone curve (ACES, Stephen Hill's fit) and the encoding screens expect. */
const DISPLAY = /* glsl */ `
vec3 display( vec3 c ) {
  c *= ${(EXPOSURE / 0.6).toFixed(5)};
  c = mat3( 0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777 ) * c;
  c = ( c * ( c + 0.0245786 ) - 0.000090537 ) / ( c * ( 0.983729 * c + 0.4329510 ) + 0.238081 );
  c = clamp( mat3( 1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602 ) * c, 0.0, 1.0 );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}`;

const VERTEX = /* glsl */ `#version 300 es
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
}`;

/** How many times the cheese close-up repeats across the pizza. Sets how big its browned patches are. */
const CHEESE_REPEAT = '1.5';
/**
 * How strongly the photo's light and dark patches show, 0 to 1. At full
 * strength its browning is so busy that it competes with the toppings.
 */
const CHEESE_DETAIL = '0.45';
/** The photo's average colour in linear light, measured from the cropped tile. */
const CHEESE_AVERAGE = 'vec3( 0.343, 0.213, 0.129 )';

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in float vDepth;
layout( location = 0 ) out vec4 oColor;
/** The surface's facing as the camera sees it, for the pixel look's outlines. */
layout( location = 1 ) out vec4 oNormal;

uniform sampler2D uMap;
uniform sampler2D uNormalMap;
uniform sampler2D uRoughMap;
uniform sampler2D uGrainMap;
uniform sampler2D uCheeseMap;
uniform sampler2DArray uEnv;
uniform sampler2DShadow uShadowMap;
uniform mat4 uView;
uniform mat4 uShadow;
uniform vec3 uEye;
uniform vec3 uColor;
uniform float uRough;
uniform float uNormalScale;
uniform float uClearcoat;
uniform vec2 uGrainRepeat;
uniform float uGrainTint;
uniform float uGrainBump;
uniform float uCheesy;
uniform float uShadowed;
uniform float uFog;

const float PI = 3.14159265;
const vec3 LUMA = vec3( 0.3, 0.59, 0.11 );
${DISPLAY}

/** The studio around the pizza in direction d, blurred to suit a surface this rough. */
float studio( vec3 d, float rough ) {
  vec2 uv = vec2( atan( d.z, d.x ) / ( 2.0 * PI ) + 0.5, 1.0 - acos( clamp( d.y, - 1.0, 1.0 ) ) / PI );
  float level = clamp( ( rough - 0.1 ) / 0.15, 0.0, ${(ENV_LEVELS - 1).toFixed(1)} );
  float below = floor( level );
  return mix(
    texture( uEnv, vec3( uv, below ) ).r,
    texture( uEnv, vec3( uv, min( below + 1.0, ${(ENV_LEVELS - 1).toFixed(1)} ) ) ).r,
    level - below
  );
}

/** Mirror-like reflection of a light off a rough surface (GGX), for a surface that reflects 4% head on. */
float glint( vec3 N, vec3 V, vec3 L, float rough ) {
  vec3 H = normalize( L + V );
  float NoL = clamp( dot( N, L ), 0.0, 1.0 );
  float NoV = clamp( dot( N, V ), 0.0, 1.0 );
  float NoH = clamp( dot( N, H ), 0.0, 1.0 );
  float VoH = clamp( dot( V, H ), 0.0, 1.0 );
  float a2 = rough * rough * rough * rough;
  float d = NoH * NoH * ( a2 - 1.0 ) + 1.0;
  float spread = a2 / ( PI * d * d );
  float visible = 0.5 / max( NoL * sqrt( a2 + ( 1.0 - a2 ) * NoV * NoV ) + NoV * sqrt( a2 + ( 1.0 - a2 ) * NoL * NoL ), 1e-6 );
  float fresnel = 0.04 + 0.96 * pow( 1.0 - VoH, 5.0 );
  return fresnel * visible * spread;
}

/** How much of its surroundings a surface reflects at this angle: a scale and an offset for its head-on reflectance. */
vec2 reflectance( float NoV, float rough ) {
  vec4 r = rough * vec4( - 1.0, - 0.0275, - 0.572, 0.022 ) + vec4( 1.0, 0.0425, 1.04, - 0.04 );
  float a = min( r.x * r.x, exp2( - 9.28 * NoV ) ) * r.x + r.y;
  return vec2( - 1.04, 1.04 ) * a + r.zw;
}

void main() {
  vec3 Ng = normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : - 1.0 );
  vec3 V = normalize( uEye - vWorld );

  /* Colour: the map, fine grain, and real mottling wherever the map is cheese. */
  vec3 albedo = texture( uMap, vUv ).rgb * uColor;
  vec2 grainUv = vUv * uGrainRepeat;
  vec3 grain = texture( uGrainMap, grainUv ).rgb;
  albedo *= 1.0 + ( grain.r - 0.5 ) * uGrainTint;
  // The painted map decides where cheese is, by its colour: cheese is yellow,
  // sauce and grease stains are red. There the photo only varies it, by how
  // far each of its texels sits from the photo's own average.
  vec2 cheeseUv = ( vUv - 0.5 ) * ${CHEESE_REPEAT};
  vec3 cheeseRaw = texture( uCheeseMap, cheeseUv ).rgb;
  float cheeseLight = dot( cheeseRaw, LUMA );
  float cheesy = uCheesy * smoothstep( 0.3, 0.55, albedo.g / max( albedo.r, 0.001 ) );
  albedo *= mix( vec3( 1.0 ), pow( cheeseRaw / ${CHEESE_AVERAGE}, vec3( ${CHEESE_DETAIL} ) ), cheesy );

  float rough = uRough * texture( uRoughMap, vUv ).g;
  rough = clamp( rough + ( grain.g - 0.5 ) * uGrainTint, 0.05, 1.0 );
  rough = clamp( rough + ( 0.25 - cheeseLight ) * 0.5 * cheesy, 0.05, 1.0 );

  /* Normal: the map's, tilted into the surface by a frame worked out from how position and uv change across the pixel. */
  vec3 q0 = dFdx( vWorld );
  vec3 q1 = dFdy( vWorld );
  vec2 st0 = dFdx( vUv );
  vec2 st1 = dFdy( vUv );
  vec3 q1perp = cross( q1, Ng );
  vec3 q0perp = cross( Ng, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float size = max( dot( T, T ), dot( B, B ) );
  float unit = size == 0.0 ? 0.0 : inversesqrt( size );
  T *= unit;
  B *= unit;
  vec3 bend = texture( uNormalMap, vUv ).xyz * 2.0 - 1.0;
  vec3 N = normalize( T * bend.x * uNormalScale + B * bend.y * uNormalScale + Ng * bend.z );
  {
    // Slope of the grain height along u and v.
    float e = 1.0 / 256.0;
    float du = texture( uGrainMap, grainUv + vec2( e, 0.0 ) ).b - grain.b;
    float dv = texture( uGrainMap, grainUv + vec2( 0.0, e ) ).b - grain.b;
    N = normalize( N - ( T * du + B * dv ) * uGrainBump );
  }
  {
    // Browned patches of cheese are darker and raised, so treat darkness as height.
    float e = 1.5 / 2048.0;
    float du = dot( texture( uCheeseMap, cheeseUv + vec2( e, 0.0 ) ).rgb, LUMA ) - cheeseLight;
    float dv = dot( texture( uCheeseMap, cheeseUv + vec2( 0.0, e ) ).rgb, LUMA ) - cheeseLight;
    N = normalize( N + ( T * du + B * dv ) * cheesy );
  }

  // A surface that curves within a pixel can't be mirror-smooth: roughen it to stop it sparkling.
  vec3 curve = max( abs( dFdx( Ng ) ), abs( dFdy( Ng ) ) );
  float curved = max( max( curve.x, curve.y ), curve.z );
  rough = min( max( rough, 0.0525 ) + curved, 1.0 );
  float coatRough = min( 0.25 + curved, 1.0 );

  /* Shadow of the key light, softened by averaging nine nearby tests. */
  float lit = 1.0;
  if ( uShadowed > 0.5 ) {
    vec3 at = ( uShadow * vec4( vWorld + normalize( vNormal ) * 0.01, 1.0 ) ).xyz * 0.5 + 0.5;
    if ( all( greaterThan( at, vec3( 0.0 ) ) ) && all( lessThan( at, vec3( 1.0 ) ) ) ) {
      lit = 0.0;
      for ( int y = - 1; y <= 1; y ++ ) {
        for ( int x = - 1; x <= 1; x ++ ) {
          lit += texture( uShadowMap, vec3( at.xy + vec2( x, y ) * ${(1.5 / SHADOW_SIZE).toFixed(6)}, at.z - 0.0004 ) );
        }
      }
      lit /= 9.0;
    }
  }

  /* The two lamps. */
  vec3 sunFrom = ${vec3(normalize(SUN_AT))};
  vec3 fillFrom = ${vec3(FILL_FROM)};
  vec3 sun = ${vec3(SUN)} * lit;
  vec3 fill = ${vec3(FILL)};
  vec3 sunOn = sun * clamp( dot( N, sunFrom ), 0.0, 1.0 );
  vec3 fillOn = fill * clamp( dot( N, fillFrom ), 0.0, 1.0 );
  vec3 diffuse = ( sunOn + fillOn ) * albedo / PI;
  vec3 shine = sunOn * glint( N, V, sunFrom, rough ) + fillOn * glint( N, V, fillFrom, rough );
  vec3 coat =
    sun * clamp( dot( Ng, sunFrom ), 0.0, 1.0 ) * glint( Ng, V, sunFrom, coatRough ) +
    fill * clamp( dot( Ng, fillFrom ), 0.0, 1.0 ) * glint( Ng, V, fillFrom, coatRough );

  /* Light from the sky above and the warm ground below. */
  diffuse += mix( ${vec3(GROUND)}, ${vec3(SKY)}, 0.5 * N.y + 0.5 ) * albedo / PI;

  /* The studio: soft light from all around, and its reflection. */
  float strength = ${ENVIRONMENT.toFixed(3)};
  float NoV = clamp( dot( N, V ), 0.0, 1.0 );
  float around = studio( N, 1.0 ) * strength;
  float mirrored = studio( normalize( mix( reflect( - V, N ), N, rough * rough ) ), rough ) * strength;
  vec2 ab = reflectance( NoV, rough );
  float once = 0.04 * ab.x + ab.y;
  float lost = 1.0 - ( ab.x + ab.y );
  // Light that bounces between the bumps of a rough surface before leaving it.
  float again = once * 0.0857 / ( 1.0 - lost * 0.0857 ) * lost;
  shine += vec3( mirrored * once + around * again );
  diffuse += albedo * ( 1.0 - once - again ) * around;

  vec3 colour = diffuse + shine;
  if ( uClearcoat > 0.0 ) {
    float NgoV = clamp( dot( Ng, V ), 0.0, 1.0 );
    vec2 cc = reflectance( NgoV, coatRough );
    coat += vec3( studio( normalize( mix( reflect( - V, Ng ), Ng, coatRough * coatRough ) ), coatRough ) * strength * ( 0.04 * cc.x + cc.y ) );
    colour = colour * ( 1.0 - uClearcoat * ( 0.04 + 0.96 * pow( 1.0 - NgoV, 5.0 ) ) ) + coat * uClearcoat;
  }

  colour = mix( colour, ${vec3(FOG)}, uFog * smoothstep( ${FOG_NEAR.toFixed(1)}, ${FOG_FAR.toFixed(1)}, vDepth ) );
  oColor = vec4( display( colour ), 1.0 );
  oNormal = vec4( normalize( mat3( uView ) * vNormal ) * 0.5 + 0.5, 1.0 );
}`;

const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D tDiffuse;
in vec2 vUv;
layout( location = 0 ) out vec4 oColor;
layout( location = 1 ) out vec4 oNormal;
${DISPLAY}
void main() {
  oColor = vec4( display( texture( tDiffuse, vUv ).rgb ), 1.0 );
  oNormal = vec4( 0.5, 0.5, 1.0, 1.0 );
}`;

const DEPTH_VERTEX = /* glsl */ `#version 300 es
layout( location = 0 ) in vec3 aPosition;
uniform mat4 uModel;
uniform mat4 uViewProjection;
void main() { gl_Position = uViewProjection * uModel * vec4( aPosition, 1.0 ); }`;

const DEPTH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
void main() {}`;

/** Vertical gradient behind the pizza: near-black overhead, an ember glow at the horizon. */
function backdropCanvas() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  // The tone curve darkens this considerably, so the stops are brighter than they look here.
  g.addColorStop(0, '#120704');
  g.addColorStop(0.2, '#2a1108');
  g.addColorStop(0.42, '#8a4a22');
  g.addColorStop(0.55, '#4a2210');
  g.addColorStop(1, '#160804');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  return c;
}

export interface Renderer {
  /** Put a geometry on the graphics card, ready to draw with a material. */
  upload(geometry: Geometry, material: Material): Mesh;
  /**
   * Set the studio the pizza reflects, from its image: blur levels stacked top
   * to bottom, each a 360° panorama in greys.
   */
  setEnvironment(image: HTMLImageElement): void;
  /** Set the fine grain texture that grained materials share. */
  setGrain(texture: WebGLTexture): void;
  render(items: Item[], view: View, target: Target | null, options?: RenderOptions): void;
  /** The pixels of a target, bottom row first. */
  read(target: Target): Uint8Array;
}

export function createRenderer(gl: GL): Renderer {
  const program = createProgram(gl, VERTEX, FRAGMENT);
  const backdrop = createProgram(gl, SCREEN_VERTEX, BACKDROP_FRAGMENT);
  const depth = createProgram(gl, DEPTH_VERTEX, DEPTH_FRAGMENT);
  const u = program.u;

  const white = createPixel(gl, 255, 255, 255);
  const level = createPixel(gl, 128, 128, 255);
  const backdropTexture = createTexture(gl, backdropCanvas(), { srgb: true, flat: true });

  // Each sampler keeps one texture unit for good.
  const units = ['uMap', 'uNormalMap', 'uRoughMap', 'uGrainMap', 'uCheeseMap', 'uEnv', 'uShadowMap'];
  gl.useProgram(program.handle);
  units.forEach((name, unit) => gl.uniform1i(u[name], unit));

  /* Shadow map: the scene's depth as the key light sees it. */
  const shadowMap = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, shadowMap);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  const shadowFbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowMap, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const shadowMatrix = multiply(orthographic(SHADOW_REACH, 0.5, 15), lookAt(SUN_AT, [0, 0, 0]));

  const environment = gl.createTexture()!;
  let grain: WebGLTexture | null = null;

  function drawShadows(items: Item[]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(depth.handle);
    gl.uniformMatrix4fv(depth.u.uViewProjection, false, shadowMatrix);
    // Draw the faces turned away from the light, so a surface never shadows itself.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    for (const { mesh, matrix } of items) {
      if (!mesh.material.casts) continue;
      gl.uniformMatrix4fv(depth.u.uModel, false, matrix);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    }
  }

  const bind = (unit: number, texture: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  };

  function useMaterial(m: Material, shadows: boolean) {
    bind(0, m.map ?? white);
    bind(1, m.normalMap ?? level);
    bind(2, m.roughMap ?? white);
    bind(3, grain ?? white);
    bind(4, m.cheese ?? white);
    gl.uniform3fv(u.uColor, m.color ?? [1, 1, 1]);
    gl.uniform1f(u.uRough, m.rough ?? 1);
    gl.uniform1f(u.uNormalScale, m.normalScale ?? 1);
    gl.uniform1f(u.uClearcoat, m.clearcoat ?? 0);
    gl.uniform2fv(u.uGrainRepeat, m.grain?.repeat ?? [1, 1]);
    gl.uniform1f(u.uGrainTint, m.grain?.tint ?? 0);
    gl.uniform1f(u.uGrainBump, m.grain?.bump ?? 0);
    gl.uniform1f(u.uCheesy, m.cheese ? 1 : 0);
    gl.uniform1f(u.uShadowed, shadows && m.receives ? 1 : 0);
    if (m.side === 'both') gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(m.side === 'back' ? gl.FRONT : gl.BACK);
    }
  }

  return {
    upload(geometry, material) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buffers = [geometry.position, geometry.normal, geometry.uv].map((data, location) => {
        const buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, location === 2 ? 2 : 3, gl.FLOAT, false, 0, 0);
        return buffer;
      });
      const index = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.index, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return {
        material,
        vao,
        count: geometry.index.length,
        free() {
          gl.deleteVertexArray(vao);
          [...buffers, index].forEach((b) => gl.deleteBuffer(b));
        },
      };
    },

    setEnvironment(image) {
      const c = document.createElement('canvas');
      c.width = ENV_WIDTH;
      c.height = ENV_HEIGHT * ENV_LEVELS;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const light = new Float32Array(ENV_WIDTH * ENV_HEIGHT * ENV_LEVELS);
      for (let l = 0; l < ENV_LEVELS; l++) {
        for (let y = 0; y < ENV_HEIGHT; y++) {
          // The image's rows run top-down, a texture's bottom-up.
          const row = (l * ENV_HEIGHT + ENV_HEIGHT - 1 - y) * ENV_WIDTH;
          for (let x = 0; x < ENV_WIDTH; x++) {
            // Brightness on a log scale, running up to 63 times white.
            light[(l * ENV_HEIGHT + y) * ENV_WIDTH + x] = Math.pow(2, (data[(row + x) * 4] / 255) * 6) - 1;
          }
        }
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, environment);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, ENV_WIDTH, ENV_HEIGHT, ENV_LEVELS, 0, gl.RED, gl.FLOAT, light);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    },

    setGrain(texture) {
      grain = texture;
    },

    render(items, view, target, { shadows = false, stage = false } = {}) {
      shadows = shadows && !stage;
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      if (shadows) drawShadows(items);

      bindTarget(gl, target);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!stage) {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.depthMask(false);
        gl.useProgram(backdrop.handle);
        bind(0, backdropTexture);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
      }

      gl.useProgram(program.handle);
      gl.uniformMatrix4fv(u.uView, false, view.view);
      gl.uniformMatrix4fv(u.uViewProjection, false, multiply(view.projection, view.view));
      gl.uniformMatrix4fv(u.uShadow, false, shadowMatrix);
      gl.uniform3fv(u.uEye, view.eye);
      gl.uniform1f(u.uFog, stage ? 0 : 1);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, environment);
      bind(6, shadowMap);
      let material: Material | null = null;
      for (const { mesh, matrix } of items) {
        if (mesh.material !== material) useMaterial((material = mesh.material), shadows);
        gl.uniformMatrix4fv(u.uModel, false, matrix);
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
      resolveTarget(gl, target);
    },

    read(target) {
      const pixels = new Uint8Array(target.width * target.height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    },
  };
}
