/**
 * post.js — render pipeline: HDR-ish rendering + bloom + cyberpunk grade.
 * Chain: RenderPass -> UnrealBloom -> FXAA -> Final(grade/CA/vignette/grain/scanlines)
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';

export const FinalGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.85 },
    uAberration: { value: 0.9 },
    uGrain: { value: 0.055 },
    uScan: { value: 0.35 },
    uDamage: { value: 0 },
    uHeal: { value: 0 },
    uFlash: { value: 0 },
    uSlow: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSaturation: { value: 1.14 },
    uLift: { value: new THREE.Vector3(0.012, 0.018, 0.032) },
    uGain: { value: new THREE.Vector3(1.03, 1.0, 1.06) },
    uPixel: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uAberration, uGrain, uScan, uDamage, uHeal, uFlash, uSlow, uSaturation, uPixel;
    uniform vec3 uLift, uGain;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // pixelation (optional retro mode)
      if (uPixel > 0.001){
        vec2 steps = mix(uRes, uRes / 4.0, uPixel);
        uv = floor(uv * steps) / steps + 0.5 / steps;
      }

      // chromatic aberration grows toward the edges
      float amt = uAberration * (0.0016 + r2 * 0.006);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * amt).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * amt).b;

      // slow-motion desaturation + adrenaline tint
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, mix(uSaturation, 1.35, uSlow));
      col = mix(col, vec3(lum) * vec3(0.75, 0.9, 1.25), uSlow * 0.35);

      // damage: red vignette + desaturation pulse; heal: green pulse
      float dmg = uDamage * smoothstep(0.12, 0.62, r2);
      col = mix(col, vec3(0.85, 0.06, 0.08), clamp(dmg, 0.0, 0.9));
      col = mix(col, vec3(0.16, 0.85, 0.55), uHeal * smoothstep(0.0, 0.6, r2) * 0.75);
      col += uFlash;

      // filmic-ish lift/gain grade
      col = col * uGain + uLift;
      col = pow(max(col, 0.0), vec3(0.96));

      // vignette
      float vig = smoothstep(0.95, 0.18, r2 * 1.35);
      col *= mix(1.0, vig, uVignette);

      // scanlines + grain
      float scan = sin(uv.y * uRes.y * 1.6 + uTime * 3.0) * 0.5 + 0.5;
      col *= 1.0 - uScan * 0.06 * scan;
      float g = hash(uv * uRes + fract(uTime) * 137.0) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Pipeline {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.enabled = opts.enabled !== false;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      opts.bloomStrength ?? 0.72,
      opts.bloomRadius ?? 0.55,
      opts.bloomThreshold ?? 0.72,
    );
    this.composer.addPass(this.bloom);

    // tone mapping + sRGB conversion happen here so FXAA and the grade pass
    // operate on final display-referred colour
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);

    this.grade = new ShaderPass(FinalGradeShader);
    this.grade.renderToScreen = true;
    this.composer.addPass(this.grade);

    this._dmg = 0;
    this.resize();
  }

  setSize(w, h, dpr) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.grade.uniforms.uRes.value.set(w * pr, h * pr);
  }

  resize() {
    const pr = this.renderer.getPixelRatio();
    this.setSize(window.innerWidth, window.innerHeight, pr);
  }

  /** Quality and look controls, applied live from the settings menu. */
  applyQuality(q) {
    if (!q) return;
    if (q.bloom !== undefined) this.bloom.enabled = q.bloom;
    if (q.grade !== undefined) this.grade.enabled = q.grade;
    if (q.aberration !== undefined) this.grade.uniforms.uAberration.value = q.aberration;
    if (q.grain !== undefined) this.grade.uniforms.uGrain.value = q.grain;
    if (q.scan !== undefined) this.grade.uniforms.uScan.value = q.scan;
    if (q.pixel !== undefined) this.grade.uniforms.uPixel.value = q.pixel;
    if (q.vignette !== undefined) this.grade.uniforms.uVignette.value = q.vignette;
    if (q.saturation !== undefined) this.grade.uniforms.uSaturation.value = q.saturation;
    if (q.lift !== undefined) this.grade.uniforms.uLift.value.set(q.lift[0], q.lift[1], q.lift[2]);
    if (q.gain !== undefined) this.grade.uniforms.uGain.value.set(q.gain[0], q.gain[1], q.gain[2]);
  }

  update(dt, state = {}) {
    this.grade.uniforms.uTime.value += dt;
    // smooth damage response
    this._dmg += ((state.damage || 0) - this._dmg) * Math.min(1, dt * 4.5);
    this.grade.uniforms.uDamage.value = this._dmg;
    this.grade.uniforms.uHeal.value += ((state.heal || 0) - this.grade.uniforms.uHeal.value) * Math.min(1, dt * 6);
    this.grade.uniforms.uFlash.value += ((state.flash || 0) - this.grade.uniforms.uFlash.value) * Math.min(1, dt * 8);
    this.grade.uniforms.uSlow.value += ((state.slow || 0) - this.grade.uniforms.uSlow.value) * Math.min(1, dt * 5);
  }

  render() {
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.composer.passes[0].scene, this.composer.passes[0].camera);
  }
}
