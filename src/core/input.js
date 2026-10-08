/**
 * input.js — keyboard, mouse and pointer-lock handling.
 * Exposes an edge-triggered action set plus continuous movement axes.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();     // pressed this frame
    this.released = new Set();
    this.mouse = { left: false, right: false, middle: false };
    this.mousePressed = new Set();
    this.mouseReleased = new Set();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.enabled = true;
    this.onLockChange = null;

    this._onKeyDown = (e) => {
      // keep browser shortcuts from stealing gameplay keys, but never block F5/F12/devtools
      if (['Tab', 'F1', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.enabled) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 1) this.mouse.middle = true;
      if (e.button === 2) this.mouse.right = true;
      this.mousePressed.add(e.button);
      e.preventDefault();
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 1) this.mouse.middle = false;
      if (e.button === 2) this.mouse.right = false;
      this.mouseReleased.add(e.button);
    };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.dx += e.movementX || 0;
      this.dy += e.movementY || 0;
    };
    this._onWheel = (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.keys.clear();
        this.mouse.left = this.mouse.right = this.mouse.middle = false;
      }
      this.onLockChange?.(this.locked);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  exitLock() { if (this.locked) document.exitPointerLock(); }

  isDown(code) { return this.enabled && this.keys.has(code); }
  wasPressed(code) { return this.enabled && this.pressed.has(code); }
  wasReleased(code) { return this.enabled && this.released.has(code); }
  mouseDown(b) { return this.enabled && (b === 0 ? this.mouse.left : b === 2 ? this.mouse.right : this.mouse.middle); }
  mouseWasPressed(b) { return this.enabled && this.mousePressed.has(b); }

  /** Movement axes: x = strafe (+right), y = forward (+forward) */
  axes() {
    let x = 0;
    let y = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) y += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) y -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  }

  /** Mouse delta in radians, consumed each frame. */
  consumeLook() {
    const s = this.sensitivity;
    const out = { yaw: -this.dx * s, pitch: (this.invertY ? this.dy : -this.dy) * s };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.wheel = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
