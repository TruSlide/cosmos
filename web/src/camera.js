// CameraController: orbit / dolly / fly camera for Cosmos.
//
// Model: the camera lives on a sphere around `target` (radius, theta, phi).
// Input only moves *goal* values; every frame the current values chase the
// goals with frame-rate-independent damping, which gives the inertial, weighty
// feel without integrating velocities. Nothing here allocates per frame.
//
//   left drag        orbit around target
//   right / shift    pan target
//   wheel / pinch    exponential dolly
//   WASD             fly (Q down, E up, Shift x4)
//
// When nobody touches it, the camera drifts around the target at 0.02 rad/s
// (ART_DIRECTION §7). Any input pauses that drift for 8 s, then it eases back in.

import * as THREE from 'three';

const AUTO_ORBIT_SPEED = 0.02;   // rad/s
const AUTO_ORBIT_PAUSE = 8;      // s after the last input
const AUTO_ORBIT_RAMP = 3;       // s to ease the drift back to full speed
const ROT_SPEED = 0.0052;        // rad per CSS px of drag
const DOLLY_SPEED = 0.0012;      // log-radius per wheel delta unit
const TAU_ROT = 0.11;            // s, orbit damping
const TAU_DOLLY = 0.16;          // s, dolly damping
const TAU_TARGET = 0.14;         // s, pan / fly damping
const PHI_MIN = 0.06;
const PHI_MAX = Math.PI - 0.06;
const EPS = 1e-4;

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const dampK = (tau, dt) => 1 - Math.exp(-dt / tau);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class CameraController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   * @param {{ target?: THREE.Vector3, minDist?: number, maxDist?: number }} [opts]
   */
  constructor(camera, domElement, opts = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.minDist = opts.minDist ?? 3;
    this.maxDist = opts.maxDist ?? 4000;
    this.autoOrbit = true;

    /** Current orbit target (read by others; write through flyTo or input). */
    this.target = (opts.target ?? new THREE.Vector3()).clone();
    this._goalTarget = this.target.clone();

    // Spherical state, current and goal. Derived from the camera's position.
    const off = new THREE.Vector3().subVectors(camera.position, this.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    this._radius = THREE.MathUtils.clamp(sph.radius || 26, this.minDist, this.maxDist);
    this._theta = sph.theta;
    this._phi = THREE.MathUtils.clamp(sph.phi || Math.PI / 2, PHI_MIN, PHI_MAX);
    this._goalRadius = this._radius;
    this._goalTheta = this._theta;
    this._goalPhi = this._phi;

    this._lastInput = -Infinity;       // seconds on the controller's own clock
    this._time = 0;
    this._listeners = new Set();
    this._keys = new Set();
    this._pointers = new Map();        // pointerId -> {x, y}
    this._pinchDist = 0;
    this._dragMode = null;             // 'orbit' | 'pan' | null
    this._moving = false;
    this._motionHint = 0;
    this._disposed = false;

    // flyTo animation state (preallocated).
    this._fly = {
      active: false, t: 0, duration: 1,
      fromTarget: new THREE.Vector3(), toTarget: new THREE.Vector3(),
      fromR: 1, toR: 1, fromTheta: 0, dTheta: 0, fromPhi: 0, toPhi: 0,
    };

    // Scratch.
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._sph = new THREE.Spherical();

    this._bind();
    this._apply();
  }

  /**
   * Rate hint for the engine: 2 while the user (or flyTo) is moving the camera,
   * 0 otherwise. The auto-orbit drifts at 0.02 rad/s (about 0.06 u per frame
   * at 10 fps), smooth enough at the idle rate, so it never keeps an unattended
   * window at 30 fps. update() still
   * returns the boolean the contract asks for.
   */
  get motionHint() {
    return this._motionHint;
  }

  /** Register a listener for any user input. @returns {() => void} unsubscribe */
  onInput(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * Eased camera move (gallery scene changes). Interpolates the target linearly
   * and the camera offset in spherical space (log radius, shortest theta), so
   * the path swings around the system instead of cutting through it.
   */
  flyTo(position, target, seconds = 1.5) {
    const f = this._fly;
    f.fromTarget.copy(this.target);
    f.toTarget.copy(target);
    this._sph.setFromVector3(this._v.subVectors(position, target));
    f.fromR = this._radius;
    f.toR = THREE.MathUtils.clamp(this._sph.radius, this.minDist, this.maxDist);
    f.fromTheta = this._theta;
    f.dTheta = wrapAngle(this._sph.theta - this._theta);
    f.fromPhi = this._phi;
    f.toPhi = THREE.MathUtils.clamp(this._sph.phi, PHI_MIN, PHI_MAX);
    f.t = 0;
    f.duration = Math.max(0.0001, seconds);
    f.active = true;
    if (seconds <= 0) this._stepFly(1);
  }

  /**
   * Advance damping, auto-orbit, fly keys and flyTo.
   * @param {number} dt seconds
   * @returns {boolean} true while the camera is moving
   */
  update(dt) {
    if (this._disposed) return false;
    this._time += dt;
    let userMotion = false;
    let autoMotion = false;

    if (this._fly.active) {
      this._fly.t += dt;
      this._stepFly(Math.min(1, this._fly.t / this._fly.duration));
      userMotion = true;
    } else {
      // WASD flight: speed scales with distance so it feels the same at any zoom.
      if (this._keys.size > 0) {
        const boost = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') ? 4 : 1;
        const speed = Math.max(2, this._radius * 0.6) * boost * dt;
        this.camera.getWorldDirection(this._fwd);
        this._right.crossVectors(this._fwd, this.camera.up).normalize();
        const k = this._keys;
        const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
        const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
        const up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
        if (fwd || side || up) {
          this._goalTarget.addScaledVector(this._fwd, fwd * speed);
          this._goalTarget.addScaledVector(this._right, side * speed);
          this._goalTarget.y += up * speed;
          this._lastInput = this._time;
          userMotion = true;
        }
      }

      // Auto-orbit eases back in after the pause, so it never starts with a jolt.
      const since = this._time - this._lastInput;
      if (this.autoOrbit && this._pointers.size === 0 && since > AUTO_ORBIT_PAUSE) {
        const ramp = Math.min(1, (since - AUTO_ORBIT_PAUSE) / AUTO_ORBIT_RAMP);
        const step = AUTO_ORBIT_SPEED * easeInOutCubic(ramp) * dt;
        this._theta += step;
        this._goalTheta += step;
        autoMotion = true;
      }

      // Chase goals.
      const kr = dampK(TAU_ROT, dt);
      const kd = dampK(TAU_DOLLY, dt);
      const kt = dampK(TAU_TARGET, dt);
      const dTh = this._goalTheta - this._theta;
      const dPh = this._goalPhi - this._phi;
      // Dolly in log space: equal wheel steps feel equal at any distance.
      const lr = Math.log(this._radius);
      const dLr = Math.log(this._goalRadius) - lr;
      this._theta += dTh * kr;
      this._phi += dPh * kr;
      this._radius = Math.exp(lr + dLr * kd);
      this._v.subVectors(this._goalTarget, this.target);
      const dTarget = this._v.length();
      this.target.addScaledVector(this._v, kt);

      if (Math.abs(dTh) > EPS || Math.abs(dPh) > EPS || Math.abs(dLr) > EPS ||
          dTarget > EPS * Math.max(1, this._radius)) {
        userMotion = true;
      } else {
        // Snap to remove sub-epsilon residue so "still" really is still.
        this._theta = this._goalTheta;
        this._phi = this._goalPhi;
        this._radius = this._goalRadius;
        this.target.copy(this._goalTarget);
      }
    }

    this._apply();
    this._moving = userMotion || autoMotion;
    this._motionHint = userMotion ? 2 : 0;
    return this._moving;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const el = this.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this._listeners.clear();
    this._keys.clear();
    this._pointers.clear();
  }

  // ---------------------------------------------------------------- internals

  _stepFly(x) {
    const f = this._fly;
    const e = easeInOutCubic(x);
    this.target.lerpVectors(f.fromTarget, f.toTarget, e);
    this._radius = Math.exp(THREE.MathUtils.lerp(Math.log(f.fromR), Math.log(f.toR), e));
    this._theta = f.fromTheta + f.dTheta * e;
    this._phi = THREE.MathUtils.lerp(f.fromPhi, f.toPhi, e);
    // Keep goals glued to the animation so damping doesn't pull back afterwards.
    this._goalTarget.copy(this.target);
    this._goalRadius = this._radius;
    this._goalTheta = this._theta;
    this._goalPhi = this._phi;
    if (x >= 1) f.active = false;
  }

  _apply() {
    this._sph.set(this._radius, this._phi, this._theta);
    this.camera.position.setFromSpherical(this._sph).add(this.target);
    this.camera.lookAt(this.target);
  }

  _notify() {
    this._lastInput = this._time;
    // A user gesture always wins over a running flyTo.
    this._fly.active = false;
    for (const fn of this._listeners) fn();
  }

  _orbitBy(dx, dy) {
    this._goalTheta -= dx * ROT_SPEED;
    this._goalPhi = THREE.MathUtils.clamp(this._goalPhi - dy * ROT_SPEED, PHI_MIN, PHI_MAX);
  }

  _panBy(dx, dy) {
    // Pan in the view plane; one pixel moves the target by the size of a pixel
    // at the target's depth, so the point under the cursor stays under it.
    const el = this.domElement;
    const h = Math.max(1, el.clientHeight);
    const worldPerPx = (2 * this._radius * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / h;
    this._right.setFromMatrixColumn(this.camera.matrix, 0);
    this._fwd.setFromMatrixColumn(this.camera.matrix, 1); // camera up
    this._goalTarget.addScaledVector(this._right, -dx * worldPerPx);
    this._goalTarget.addScaledVector(this._fwd, dy * worldPerPx);
  }

  _dolly(delta) {
    this._goalRadius = THREE.MathUtils.clamp(
      this._goalRadius * Math.exp(delta * DOLLY_SPEED), this.minDist, this.maxDist);
  }

  _bind() {
    const el = this.domElement;
    el.style.touchAction = 'none';

    this._onPointerDown = (e) => {
      if (this._disposed) return;
      el.setPointerCapture?.(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 2) {
        this._pinchDist = this._pointerSpread();
        this._dragMode = 'pan';
      } else {
        this._dragMode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
      }
      this._notify();
    };

    this._onPointerMove = (e) => {
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this._pointers.size === 2) {
        // Pinch: dolly by the change in finger spread, pan by the midpoint drift.
        const spread = this._pointerSpread();
        if (this._pinchDist > 0 && spread > 0) {
          this._goalRadius = THREE.MathUtils.clamp(
            this._goalRadius * (this._pinchDist / spread), this.minDist, this.maxDist);
        }
        this._pinchDist = spread;
        this._panBy(dx / 2, dy / 2);
      } else if (this._dragMode === 'pan') {
        this._panBy(dx, dy);
      } else {
        this._orbitBy(dx, dy);
      }
      this._notify();
    };

    this._onPointerUp = (e) => {
      this._pointers.delete(e.pointerId);
      el.releasePointerCapture?.(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0) this._dragMode = null;
      this._notify();
    };

    this._onWheel = (e) => {
      e.preventDefault();
      // Normalize line/page deltas to pixels; clamp so a trackpad fling stays calm.
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this._dolly(THREE.MathUtils.clamp(e.deltaY * scale, -240, 240));
      this._notify();
    };

    this._onContextMenu = (e) => e.preventDefault();

    this._onKeyDown = (e) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (FLY_KEYS.has(e.code) || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this._keys.add(e.code);
        if (FLY_KEYS.has(e.code)) this._notify();
      }
    };

    this._onKeyUp = (e) => {
      this._keys.delete(e.code);
    };

    // Released keys are never seen after a blur; drop them so we don't fly forever.
    this._onBlur = () => {
      this._keys.clear();
      this._pointers.clear();
      this._dragMode = null;
    };

    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointercancel', this._onPointerUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  _pointerSpread() {
    let ax = 0, ay = 0, bx = 0, by = 0, i = 0;
    for (const p of this._pointers.values()) {
      if (i === 0) { ax = p.x; ay = p.y; } else if (i === 1) { bx = p.x; by = p.y; }
      i++;
    }
    return Math.hypot(ax - bx, ay - by);
  }
}

function isTyping(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
