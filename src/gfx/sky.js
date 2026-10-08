/**
 * sky.js — procedural sky dome + IBL environment + animated atmosphere.
 * The sky doubles as the light probe: city glow at the horizon, a moon and
 * stars above, drifting clouds of dust and haze.
 */
import * as THREE from 'three';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform float uTime;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGlow;
uniform vec3 uMoonDir;
uniform float uStars;

float hash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71,0.113,0.419)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=0.5;} return s; }

void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  // base gradient
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h,0.0,1.0), 0.55));
  // ground haze below the horizon
  col = mix(col * 0.35, col, smoothstep(-0.25, 0.02, h));

  // horizon city glow, stronger toward one side
  float glowAmt = pow(clamp(1.0 - abs(h)*2.3, 0.0, 1.0), 2.0);
  float side = 0.55 + 0.45 * sin(atan(d.z, d.x) * 2.0 + 0.7);
  col += uGlow * glowAmt * side * 0.9;

  // stars
  vec3 sp = d * 140.0;
  float star = pow(hash(floor(sp)), 42.0) * 3.0;
  float tw = 0.65 + 0.35 * sin(uTime * 2.2 + hash(floor(sp)) * 40.0);
  col += vec3(0.85, 0.92, 1.0) * star * tw * smoothstep(0.02, 0.4, h) * uStars;

  // moon + halo
  float md = max(dot(d, normalize(uMoonDir)), 0.0);
  col += vec3(0.85, 0.92, 1.0) * pow(md, 900.0) * 3.0;
  col += vec3(0.20, 0.28, 0.45) * pow(md, 12.0) * 0.5;

  // clouds / smog band
  float cloud = fbm(vec3(d.xz * 2.2 / max(0.25, h + 0.35), uTime * 0.012 + d.y));
  cloud = smoothstep(0.45, 0.95, cloud + (1.0 - clamp(h*3.0,0.0,1.0)) * 0.35);
  col = mix(col, mix(vec3(0.05,0.06,0.10), uGlow*0.6, 0.35), cloud * 0.55 * smoothstep(-0.05, 0.5, h));

  // subtle dithering removes banding
  col += (hash(d * 733.0) - 0.5) * 0.012;
  gl_FragColor = vec4(col, 1.0);
}`;

export class SkyDome {
  constructor(scene, renderer, opts = {}) {
    this.renderer = renderer;
    this.uniforms = {
      uTime: { value: 0 },
      uHorizon: { value: new THREE.Color(opts.horizon ?? 0x121a2c) },
      uZenith: { value: new THREE.Color(opts.zenith ?? 0x03040a) },
      uGlow: { value: new THREE.Color(opts.glow ?? 0x1b6f8c) },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.72, 0.55).normalize() },
      uStars: { value: opts.stars ?? 1.0 },
    };
    const geo = new THREE.SphereGeometry(400, 40, 24);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    // Directional "moonlight" matching the sky, plus cheap city fill lights.
    this.moon = new THREE.DirectionalLight(0x9fc0ff, 1.15);
    this.moon.position.copy(this.uniforms.uMoonDir.value).multiplyScalar(60);
    this.moon.castShadow = true;
    scene.add(this.moon);
    scene.add(this.moon.target);

    this.fillA = new THREE.DirectionalLight(0x2a6f9e, 0.55);
    this.fillA.position.set(1, 0.25, -0.6).multiplyScalar(40);
    scene.add(this.fillA);
    this.fillB = new THREE.DirectionalLight(0x2e5f7a, 0.35);
    this.fillB.position.set(-0.8, 0.2, 0.7).multiplyScalar(40);
    scene.add(this.fillB);

    this.hemi = new THREE.HemisphereLight(0x2c4a66, 0x0a0d12, 0.35);
    scene.add(this.hemi);
  }

  update(dt, camera) {
    this.uniforms.uTime.value += dt;
    this.mesh.position.copy(camera.position);
    this.moon.position.copy(camera.position).addScaledVector(this.uniforms.uMoonDir.value, 60);
    this.moon.target.position.copy(camera.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Bake a PMREM environment probe from an equirectangular procedural sky so
 * every PBR material gets believable reflections without any HDR file.
 */
export function buildEnvironment(renderer, opts = {}) {
  const W = 512;
  const H = 256;
  const data = new Float32Array(W * H * 4);
  const moon = new THREE.Vector3(-0.4, 0.72, 0.55).normalize();
  const horizon = new THREE.Color(opts.horizon ?? 0x1a2740);
  const zenith = new THREE.Color(opts.zenith ?? 0x04060e);
  const glow = new THREE.Color(opts.glow ?? 0x1b6f8c);

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const theta = v * Math.PI;           // 0 = up
    const dy = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const phi = u * Math.PI * 2;
      const dx = sinT * Math.cos(phi);
      const dz = sinT * Math.sin(phi);
      const up = Math.max(0, dy);
      const r = zenith.r * (1 - up) + horizon.r * up;
      const g = zenith.g * (1 - up) + horizon.g * up;
      const b = zenith.b * (1 - up) + horizon.b * up;
      const glowAmt = Math.pow(Math.max(0, 1 - Math.abs(dy) * 2.3), 2) * (0.55 + 0.45 * Math.sin(phi * 2 + 0.7));
      const md = Math.max(0, dx * moon.x + dy * moon.y + dz * moon.z);
      const moonAmt = Math.pow(md, 200) * 40 + Math.pow(md, 8) * 0.35;
      const o = (y * W + x) * 4;
      data[o] = (r + glow.r * glowAmt + moonAmt) * 1.1;
      data[o + 1] = (g + glow.g * glowAmt + moonAmt) * 1.1;
      data[o + 2] = (b + glow.b * glowAmt + moonAmt) * 1.1;
      data[o + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose();
  pmrem.dispose();
  return rt.texture;
}
