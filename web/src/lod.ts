// Level of detail: each frame, decide which octree nodes to show.
// Nodes are visited biggest-on-screen first until the point budget is spent; anything
// visible that isn't loaded yet is queued, and nodes nobody has looked at for a while are freed.
import * as THREE from 'three';
import type { Cloud, Node } from './cloud';

export interface LodStats { visible: number; points: number; loading: number; loaded: number }

const MAX_LOADS = 6;      // requests in flight
const MIN_PIXELS = 90;    // a node smaller than this on screen isn't worth opening
const KEEP_LOADED = 900;  // node geometries kept in memory before the oldest are freed

const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const centre = new THREE.Vector3();

export class Lod {
  budget = 4_000_000;
  private frame = 0;
  private inFlight = 0;

  constructor(private cloud: Cloud) {}

  update(camera: THREE.PerspectiveCamera, viewportHeight: number): LodStats {
    this.frame++;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const focal = viewportHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);

    // Visit nodes in order of how big they look; parents always come before children.
    const queue: { node: Node; weight: number }[] = [{ node: this.cloud.root, weight: Infinity }];
    const wanted: Node[] = [];
    let points = 0, visible = 0;
    for (const n of this.cloud.all) if (n.points) n.points.visible = false;

    while (queue.length) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].weight > queue[best].weight) best = i;
      const { node } = queue[best];
      queue[best] = queue[queue.length - 1];
      queue.pop();

      if (points + node.count > this.budget) continue;
      if (!node.points) { if (!node.failed) wanted.push(node); continue; }
      node.points.visible = true;
      node.lastUsed = this.frame;
      points += node.count;
      visible++;

      for (const child of node.children) {
        if (!frustum.intersectsBox(child.box)) continue;
        const radius = child.box.getSize(centre).length() / 2;
        child.box.getCenter(centre);
        const dist = Math.max(centre.distanceTo(camera.position) - radius, 0.001);
        const pixels = (radius * focal) / dist;
        if (pixels < MIN_PIXELS) continue;
        queue.push({ node: child, weight: pixels });
      }
    }

    // Size each node's points for the finest level drawn beneath it, so coarse samples
    // shrink to fit between the detail that has loaded on top of them.
    const deepest = (n: Node): number => {
      let d = n.level;
      for (const c of n.children) if (c.points?.visible) d = Math.max(d, deepest(c));
      n.deepestShown = d;
      return d;
    };
    deepest(this.cloud.root);

    // Load the most important missing nodes first (they were found in priority order).
    for (const node of wanted) {
      if (this.inFlight >= MAX_LOADS) break;
      if (node.loading) continue;
      this.inFlight++;
      this.cloud.load(node).finally(() => this.inFlight--);
    }

    // Free memory from nodes that haven't been on screen for a while.
    const loaded = this.cloud.all.filter((n) => n.points);
    if (loaded.length > KEEP_LOADED) {
      loaded.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const n of loaded.slice(0, loaded.length - KEEP_LOADED)) if (n.lastUsed < this.frame - 2 && n.level > 0) this.cloud.unload(n);
    }

    return { visible, points, loading: this.inFlight, loaded: loaded.length };
  }
}
