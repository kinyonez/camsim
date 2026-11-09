import { Euler, MathUtils, type PerspectiveCamera, Vector2, Vector3 } from 'three';

// 一人称のカメラ移動。ドラッグで向き、WASD で水平移動、E/Q で上下、ホイールで前後、クリックで AF。
export class WalkControls {
  yaw = 0;
  pitch = 0;
  speed = 6; // m/s
  onClick: ((ndc: Vector2) => void) | null = null;
  onChange: (() => void) | null = null;

  private keys = new Set<string>();
  private dragging = false;
  private dragDistance = 0;
  private last = new Vector2();
  private euler = new Euler(0, 0, 0, 'YXZ');

  constructor(
    private camera: PerspectiveCamera,
    dom: HTMLElement,
    private bounds: { half: number; minY: number; maxY: number },
  ) {
    dom.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragDistance = 0;
      this.last.set(e.clientX, e.clientY);
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last.set(e.clientX, e.clientY);
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      // 画角に比例させ、望遠でも「画面をつかんで動かす」感覚にする
      const radPerPx = MathUtils.degToRad(this.camera.fov) / dom.clientHeight;
      this.yaw += dx * radPerPx;
      this.pitch = MathUtils.clamp(this.pitch + dy * radPerPx, -1.5, 1.5);
      this.apply();
    });
    dom.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (this.dragDistance < 4 && this.onClick) {
        const r = dom.getBoundingClientRect();
        this.onClick(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
      }
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.move(new Vector3(0, 0, Math.sign(e.deltaY) * 1));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** yaw/pitch をカメラに反映 */
  apply(): void {
    this.euler.set(-this.pitch, -this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    this.onChange?.();
  }

  update(dt: number): void {
    const v = new Vector3();
    if (this.keys.has('KeyW')) v.z -= 1;
    if (this.keys.has('KeyS')) v.z += 1;
    if (this.keys.has('KeyA')) v.x -= 1;
    if (this.keys.has('KeyD')) v.x += 1;
    if (this.keys.has('KeyE')) v.y += 1;
    if (this.keys.has('KeyQ')) v.y -= 1;
    if (v.lengthSq() === 0) return;
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5 : 1;
    this.move(v.normalize().multiplyScalar(this.speed * boost * dt));
  }

  /** カメラの水平向き基準で移動 (y は鉛直) */
  private move(local: Vector3): void {
    const forward = new Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const p = this.camera.position;
    p.addScaledVector(right, local.x).addScaledVector(forward, -local.z);
    p.y += local.y;
    const { half, minY, maxY } = this.bounds;
    p.set(MathUtils.clamp(p.x, -half, half), MathUtils.clamp(p.y, minY, maxY), MathUtils.clamp(p.z, -half, half));
    this.onChange?.();
  }
}
