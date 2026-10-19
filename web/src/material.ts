// Point shading: four colour modes, class filtering, and point sizes that fill the gaps
// between a node's samples, plus eye-dome lighting as a full-screen pass for depth.
import * as THREE from 'three';

export const COLOR_MODES = ['height', 'classification', 'intensity', 'rgb'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

// ASPRS LAS classes. Names are what the viewer shows; colours are picked to read on a dark background.
export const CLASSES: Record<number, { name: string; color: string }> = {
  0: { name: 'Never classified', color: '#8a8f98' },
  1: { name: 'Unclassified', color: '#9aa1ab' },
  2: { name: 'Ground', color: '#b08a5a' },
  3: { name: 'Low vegetation', color: '#7fbf6a' },
  4: { name: 'Medium vegetation', color: '#4f9e4a' },
  5: { name: 'High vegetation', color: '#2f7d3c' },
  6: { name: 'Building', color: '#e0664a' },
  7: { name: 'Low noise', color: '#d94fd1' },
  8: { name: 'Key point', color: '#f2d24b' },
  9: { name: 'Water', color: '#3f8ee8' },
  10: { name: 'Rail', color: '#c9a227' },
  11: { name: 'Road surface', color: '#5c5f66' },
  12: { name: 'Overlap', color: '#a0a0a0' },
  13: { name: 'Wire guard', color: '#f2f2f2' },
  14: { name: 'Wire conductor', color: '#ffe066' },
  15: { name: 'Transmission tower', color: '#ff9f43' },
  16: { name: 'Wire connector', color: '#fffbe6' },
  17: { name: 'Bridge deck', color: '#c2a3ff' },
  18: { name: 'High noise', color: '#ff4fd8' },
};

function classTexture(hidden: Set<number>): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = new THREE.Color(CLASSES[i]?.color ?? '#9aa1ab');
    data.set([c.r * 255, c.g * 255, c.b * 255, hidden.has(i) ? 0 : 255], i * 4);
  }
  const t = new THREE.DataTexture(data, 256, 1);
  t.needsUpdate = true;
  return t;
}

// Height ramp: deep blue (low) through teal, green, yellow to white (high), like a survey hypsometric tint.
function rampTexture(): THREE.DataTexture {
  const stops = ['#1b2a6b', '#1f6f9f', '#25a39a', '#7cc86a', '#e6d65a', '#f0a04b', '#fdf6e3'];
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = new THREE.Color(stops[Math.floor(t)]);
    const b = new THREE.Color(stops[Math.min(Math.ceil(t), stops.length - 1)]);
    const c = a.lerp(b, t - Math.floor(t));
    data.set([c.r * 255, c.g * 255, c.b * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, 256, 1);
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function pointMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      colorMode: { value: 0 },
      zRange: { value: new THREE.Vector2(0, 1) },
      intensityRange: { value: new THREE.Vector2(0, 1) },
      spacing: { value: 1 },
      focal: { value: 1000 },
      sizeScale: { value: 1.0 },
      classes: { value: classTexture(new Set()) },
      ramp: { value: rampTexture() },
      hasRgb: { value: false },
    },
    vertexShader: /* glsl */ `
      attribute float classification;
      attribute float intensity;
      attribute vec3 rgb;
      uniform int colorMode;
      uniform vec2 zRange;
      uniform vec2 intensityRange;
      uniform float spacing;
      uniform float focal;
      uniform float sizeScale;
      uniform sampler2D classes;
      uniform sampler2D ramp;
      uniform bool hasRgb;
      varying vec3 vColor;
      varying float vHidden;
      void main() {
        vec4 cls = texture2D(classes, vec2((classification + 0.5) / 256.0, 0.5));
        vHidden = cls.a < 0.5 ? 1.0 : 0.0;
        if (colorMode == 0) {
          float h = clamp((position.z - zRange.x) / max(zRange.y - zRange.x, 0.001), 0.0, 1.0);
          vColor = texture2D(ramp, vec2(h, 0.5)).rgb;
        } else if (colorMode == 1) {
          vColor = cls.rgb;
        } else if (colorMode == 2) {
          float i = clamp((intensity - intensityRange.x) / max(intensityRange.y - intensityRange.x, 1.0), 0.0, 1.0);
          vColor = vec3(pow(i, 0.7));
        } else {
          vColor = hasRgb ? rgb : cls.rgb;
        }
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // big enough to cover the gap to the next sample in this node, never smaller than 1.5 px
        gl_PointSize = clamp(spacing * 1.4 * focal / -mv.z * sizeScale, 1.5, 24.0);
        if (vHidden > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        if (dot(c, c) > 1.0) discard;     // round points
        gl_FragColor = vec4(vColor, 1.0);
      }`,
  });
}

export function setHiddenClasses(m: THREE.ShaderMaterial, hidden: Set<number>) {
  (m.uniforms.classes.value as THREE.Texture).dispose();
  m.uniforms.classes.value = classTexture(hidden);
}

// Eye-dome lighting: darkens each pixel by how much nearer its neighbours are,
// which draws outlines and depth into a cloud of unlit points.
export class EyeDome {
  readonly target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;
  enabled = true;

  constructor(width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(width, height, { depthTexture: new THREE.DepthTexture(width, height, THREE.FloatType) });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        resolution: { value: new THREE.Vector2(width, height) },
        near: { value: 0.1 },
        far: { value: 10000 },
        strength: { value: 1.0 },
        background: { value: new THREE.Color('#0b0e14') },
        enabled: { value: true },
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 resolution;
        uniform float near;
        uniform float far;
        uniform float strength;
        uniform vec3 background;
        uniform bool enabled;
        varying vec2 vUv;
        float logDepth(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          if (d >= 1.0) return 0.0;
          float z = (near * far) / (far - d * (far - near));   // linear eye distance
          return log2(z);
        }
        void main() {
          float d = texture2D(tDepth, vUv).x;
          vec3 color = texture2D(tColor, vUv).rgb;
          if (d >= 1.0) { gl_FragColor = vec4(background, 1.0); return; }
          if (!enabled) { gl_FragColor = vec4(color, 1.0); return; }
          float here = logDepth(vUv);
          vec2 px = 1.4 / resolution;
          float sum = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7853982;
            float n = logDepth(vUv + vec2(cos(a), sin(a)) * px);
            sum += n == 0.0 ? 0.6 : max(0.0, here - n);
          }
          float shade = exp(-sum / 8.0 * 300.0 * strength * 0.02);
          gl_FragColor = vec4(color * shade, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  setSize(w: number, h: number) {
    this.target.setSize(w, h);
    this.material.uniforms.resolution.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.material.uniforms.near.value = camera.near;
    this.material.uniforms.far.value = camera.far;
    this.material.uniforms.enabled.value = this.enabled;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
}
