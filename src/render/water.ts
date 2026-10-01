/**
 * Water shading physics, wave harmonics & shoreline foam — W1 (Issue #128).
 *
 * Implements modern RTS water rendering:
 * 1. Dual-octave wave normal perturbation for fluid surface ripples.
 * 2. View-dependent Fresnel reflection (Schlick's approximation) reflecting sky color.
 * 3. Dynamic shoreline foam & surf wash at land/water boundaries.
 * 4. Celestial sun specular glints responding to dynamic sunlight angles.
 * 5. Depth color gradient from shallow coastal turquoise to deep ocean navy.
 *
 * Designed to be pure-math and shader-generation safe so all optics formulas
 * can be verified in headless unit tests without browser WebGL dependencies.
 */

import { Color, Vector3 } from "three";

/** Deep ocean abyss color [R, G, B] */
export const WATER_DEEP_COLOR: readonly [number, number, number] = [
  0.03, 0.11, 0.22,
];

/** Shallow coastal turquoise color [R, G, B] */
export const WATER_SHALLOW_COLOR: readonly [number, number, number] = [
  0.10, 0.55, 0.65,
];

/** Seafoam crest and surf color [R, G, B] */
export const WATER_FOAM_COLOR: readonly [number, number, number] = [
  0.92, 0.96, 1.0,
];

/** Reflectance of water at normal incidence (per Fresnel dielectric equations). */
export const WATER_FRESNEL_F0 = 0.02;

/**
 * Analytical Schlick Fresnel approximation:
 * F(theta) = F0 + (1 - F0) * (1 - cos(theta))^4
 */
export function calculateFresnel(
  cosTheta: number,
  f0 = WATER_FRESNEL_F0,
): number {
  const clamped = Math.max(0, Math.min(1, cosTheta));
  return f0 + (1 - f0) * Math.pow(1 - clamped, 4);
}

/**
 * Pure analytical calculation of water depth color blending.
 * depthFactor: 0.0 = deep ocean, 1.0 = shallow water
 */
export function calculateWaterDepthColor(
  depthFactor: number,
): [number, number, number] {
  const t = Math.max(0, Math.min(1, depthFactor));
  return [
    WATER_DEEP_COLOR[0] * (1 - t) + WATER_SHALLOW_COLOR[0] * t,
    WATER_DEEP_COLOR[1] * (1 - t) + WATER_SHALLOW_COLOR[1] * t,
    WATER_DEEP_COLOR[2] * (1 - t) + WATER_SHALLOW_COLOR[2] * t,
  ];
}

/**
 * Pure analytical calculation of dynamic coastal foam intensity.
 * @param shoreProximity Proximity factor to land (0.0 = deep water, 1.0 = right at shore)
 * @param time Current simulation / render time in seconds
 * @param worldX World X coordinate
 * @param worldZ World Z coordinate
 */
export function calculateFoamFactor(
  shoreProximity: number,
  time: number,
  worldX: number,
  worldZ: number,
): number {
  if (shoreProximity < 0.1) return 0;

  // Wave wash oscillating against shoreline
  const surfWave =
    Math.sin(time * 2.8 - shoreProximity * 14.0 + (worldX + worldZ) * 3.5);
  // High-frequency surface froth turbulence
  const froth =
    Math.sin(worldX * 24.0 + time * 2.0) * Math.cos(worldZ * 24.0 - time * 1.5);

  const foamLine =
    smoothstep(0.18, 0.55, shoreProximity) * smoothstep(0.1, 0.85, surfWave);
  const intensity = (foamLine + froth * 0.22) * 1.8;
  return Math.max(0, Math.min(1, intensity));
}

function smoothstep(min: number, max: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

export interface WaterUniforms {
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  uSkyColor: { value: Color };
  uWaterDeepColor: { value: Color };
  uWaterShallowColor: { value: Color };
  uFoamColor: { value: Color };
}

/**
 * Create default shader uniforms for water rendering.
 */
export function createWaterUniforms(): WaterUniforms {
  return {
    uSunDir: { value: new Vector3(0.5, 1.4, 0.7).normalize() },
    uSunColor: { value: new Color(1.0, 0.98, 0.94) },
    uSkyColor: { value: new Color(0.68, 0.82, 0.96) },
    uWaterDeepColor: {
      value: new Color(
        WATER_DEEP_COLOR[0],
        WATER_DEEP_COLOR[1],
        WATER_DEEP_COLOR[2],
      ),
    },
    uWaterShallowColor: {
      value: new Color(
        WATER_SHALLOW_COLOR[0],
        WATER_SHALLOW_COLOR[1],
        WATER_SHALLOW_COLOR[2],
      ),
    },
    uFoamColor: {
      value: new Color(
        WATER_FOAM_COLOR[0],
        WATER_FOAM_COLOR[1],
        WATER_FOAM_COLOR[2],
      ),
    },
  };
}

/**
 * GLSL fragment shader logic for dynamic water shading with dual-octave normals,
 * Fresnel reflection, coastal foam wash, and celestial sun specular glints.
 */
export const WATER_FRAGMENT_GLSL = /* glsl */ `
        // ---- Advanced Dynamic Water Shading (W1 / #128) ----------------------
        // 1. Dual-octave counter-propagating wave fields for fluid surface normal
        vec2 waveUv1 = vWorldUv * 1.6 + vec2(uTime * 0.05, uTime * 0.035);
        vec2 waveUv2 = vWorldUv * 2.4 - vec2(uTime * 0.035, -uTime * 0.055);
        float n1 = sin(waveUv1.x * 5.2 + waveUv1.y * 3.8);
        float n2 = cos(waveUv2.x * 6.8 - waveUv2.y * 5.2);
        vec2 waveUv3 = vWorldUv * 4.2 + vec2(-uTime * 0.08, uTime * 0.06);
        float n3 = sin(waveUv3.x * 7.5 + waveUv3.y * 7.5);
        float waveRipple = (n1 + n2) * 0.45 + n3 * 0.1;

        // Wave surface normal perturbation
        vec3 waveNormal = normalize(vec3((n1 * 0.14 + n3 * 0.07), 1.0, (n2 * 0.14 + n3 * 0.07)));

        // 2. View direction & Fresnel reflectance factor
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float NdotV = clamp(dot(waveNormal, viewDir), 0.0, 1.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 4.0);

        // 3. Dynamic underwater caustics
        float causticTime = uTime * 1.8;
        float caustics = sin((vWorldUv.x + vWorldUv.y) * 6.8 + causticTime) * 0.5 + 0.5;

        // 4. Depth color gradient (deep ocean vs shallow coastal turquoise)
        float depthFactor = clamp(vTerrainType, 0.0, 1.0);
        vec3 waterBase = mix(uWaterDeepColor, uWaterShallowColor, depthFactor);
        vec3 waterColor = waterBase + vec3(0.015, 0.04, 0.06) * waveRipple + vec3(0.02, 0.05, 0.07) * caustics;

        // 5. Sky reflection modulated by Fresnel
        vec3 reflectedSky = mix(uSkyColor, uSunColor, 0.25) * 1.15;
        vec3 surfaceWater = mix(waterColor, reflectedSky, fresnel * 0.65);

        // 6. Celestial sun specular glints (Blinn-Phong)
        vec3 halfDir = normalize(uSunDir + viewDir);
        float NdotH = max(0.0, dot(waveNormal, halfDir));
        float specular = pow(NdotH, 64.0) * (0.85 + 0.15 * waveRipple);
        vec3 sunGlint = uSunColor * specular * 1.6;

        // 7. Dynamic Coastal Foam & Surf Wash
        // splat.r = shore sand weight, splat.g/b = adjacent land
        float shoreProximity = clamp(splat.r * 1.6 + (splat.g + splat.b) * 0.6, 0.0, 1.0);
        float surfWave = sin(uTime * 2.8 - shoreProximity * 14.0 + (vWorldUv.x + vWorldUv.y) * 3.5);
        float froth = sin(vWorldUv.x * 24.0 + uTime * 2.0) * cos(vWorldUv.y * 24.0 - uTime * 1.5);
        float foamLine = smoothstep(0.18, 0.55, shoreProximity) * smoothstep(0.1, 0.85, surfWave);
        float foamFactor = clamp((foamLine + froth * 0.22) * 1.8, 0.0, 1.0);

        vec3 finalWater = surfaceWater + sunGlint;
        texColor = mix(finalWater, uFoamColor, foamFactor * 0.85);
`;
