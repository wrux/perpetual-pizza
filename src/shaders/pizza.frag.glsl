#version 300 es
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
/** How many times the cheese close-up repeats across the pizza. Sets how big its browned patches are. */
const float CHEESE_REPEAT = 1.5;
/**
 * How strongly the photo's light and dark patches show, 0 to 1. At full
 * strength its browning is so busy that it competes with the toppings.
 */
const float CHEESE_DETAIL = 0.45;
/** The photo's average colour in linear light, measured from the cropped tile. */
const vec3 CHEESE_AVERAGE = vec3( 0.343, 0.213, 0.129 );
const vec3 LUMA = vec3( 0.3, 0.59, 0.11 );
#include <display>

/** The studio around the pizza in direction d, blurred to suit a surface this rough. */
float studio( vec3 d, float rough ) {
  vec2 uv = vec2( atan( d.z, d.x ) / ( 2.0 * PI ) + 0.5, 1.0 - acos( clamp( d.y, - 1.0, 1.0 ) ) / PI );
  float level = clamp( ( rough - 0.1 ) / 0.15, 0.0, ENV_TOP );
  float below = floor( level );
  return mix(
    texture( uEnv, vec3( uv, below ) ).r,
    texture( uEnv, vec3( uv, min( below + 1.0, ENV_TOP ) ) ).r,
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
  vec2 cheeseUv = ( vUv - 0.5 ) * CHEESE_REPEAT;
  vec3 cheeseRaw = texture( uCheeseMap, cheeseUv ).rgb;
  float cheeseLight = dot( cheeseRaw, LUMA );
  float cheesy = uCheesy * smoothstep( 0.3, 0.55, albedo.g / max( albedo.r, 0.001 ) );
  albedo *= mix( vec3( 1.0 ), pow( cheeseRaw / CHEESE_AVERAGE, vec3( CHEESE_DETAIL ) ), cheesy );

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
          lit += texture( uShadowMap, vec3( at.xy + vec2( x, y ) * SHADOW_STEP, at.z - 0.0004 ) );
        }
      }
      lit /= 9.0;
    }
  }

  /* The two lamps. */
  vec3 sunFrom = SUN_FROM;
  vec3 fillFrom = FILL_FROM;
  vec3 sun = SUN * lit;
  vec3 fill = FILL;
  vec3 sunOn = sun * clamp( dot( N, sunFrom ), 0.0, 1.0 );
  vec3 fillOn = fill * clamp( dot( N, fillFrom ), 0.0, 1.0 );
  vec3 diffuse = ( sunOn + fillOn ) * albedo / PI;
  vec3 shine = sunOn * glint( N, V, sunFrom, rough ) + fillOn * glint( N, V, fillFrom, rough );
  vec3 coat =
    sun * clamp( dot( Ng, sunFrom ), 0.0, 1.0 ) * glint( Ng, V, sunFrom, coatRough ) +
    fill * clamp( dot( Ng, fillFrom ), 0.0, 1.0 ) * glint( Ng, V, fillFrom, coatRough );

  /* Light from the sky above and the warm ground below. */
  diffuse += mix( GROUND, SKY, 0.5 * N.y + 0.5 ) * albedo / PI;

  /* The studio: soft light from all around, and its reflection. */
  float strength = ENVIRONMENT;
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

  colour = mix( colour, FOG, uFog * smoothstep( FOG_NEAR, FOG_FAR, vDepth ) );
  oColor = vec4( display( colour ), 1.0 );
  oNormal = vec4( normalize( mat3( uView ) * vNormal ) * 0.5 + 0.5, 1.0 );
}
