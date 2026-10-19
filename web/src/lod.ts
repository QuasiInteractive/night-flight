// Level of detail: each frame, decide which octree nodes to show.
// Nodes are visited biggest-on-screen first until the point budget is spent; anything
// visible that isn't loaded yet is queued, and nodes nobody has looked at for a while are freed.
// Work per frame scales with what's on screen, not with the size of the whole cloud.
import * as THREE from 'three';
import type { Cloud, Node } from './cloud';

export interface LodStats { visible: number; points: number; loading: number; loaded: number }

const MAX_LOADS = 6;      // requests in flight
const MIN_PIXELS = 90;    // a node smaller than this on screen isn't worth opening
const KEEP_LOADED = 1500; // node geometries kept in memory before the oldest are freed

const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const centre = new THREE.Vector3();
const size = new THREE.Vector3();

// Max-heap of nodes by on-screen size.
class Heap {
  private items: { node: Node; weight: number }[] = [];
  get length() { return this.items.length; }
  push(node: Node, weight: number) {
    const a = this.items;
    a.push({ node, weight });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].weight >= a[i].weight) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].weight > a[m].weight) m = l;
        if (r < a.length && a[r].weight > a[m].weight) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.node;
  }
}

export class Lod {
  budget = 4_000_000;
  private frame = 0;
  private inFlight = 0;
  private shown: Node[] = [];

  constructor(private cloud: Cloud) {}

  update(camera: THREE.PerspectiveCamera, viewportHeight: number): LodStats {
    this.frame++;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const focal = viewportHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);

    for (const n of this.shown) if (n.points) n.points.visible = false;
    this.shown = [];

    const heap = new Heap();
    heap.push(this.cloud.root, Infinity);
    const wanted: Node[] = [];
    let points = 0;

    while (heap.length) {
      const node = heap.pop();
      if (points + node.count > this.budget) continue;
      if (!node.points) {
        if (!node.failed && wanted.length < 64) wanted.push(node);
        continue;
      }
      node.points.visible = true;
      node.lastUsed = this.frame;
      this.shown.push(node);
      points += node.count;

      for (const child of node.children) {
        if (!frustum.intersectsBox(child.box)) continue;
        const radius = child.box.getSize(size).length() / 2;
        child.box.getCenter(centre);
        const dist = Math.max(centre.distanceTo(camera.position) - radius, 0.001);
        const pixels = (radius * focal) / dist;
        if (pixels < MIN_PIXELS) continue;
        heap.push(child, pixels);
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

    // Free memory from nodes that haven't been on screen for a while (checked once a second).
    const loaded = this.cloud.loaded;
    if (this.frame % 60 === 0 && loaded.size > KEEP_LOADED) {
      const old = [...loaded].filter((n) => n.level > 0 && n.lastUsed < this.frame - 2).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const n of old.slice(0, loaded.size - KEEP_LOADED)) this.cloud.unload(n);
    }

    return { visible: this.shown.length, points, loading: this.inFlight, loaded: loaded.size };
  }
}
