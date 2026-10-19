// A streamed point cloud: the octree from tiler/tile.py, loaded node by node where the camera looks.
import * as THREE from 'three';

export interface CloudMeta {
  version: number;
  points: number;
  origin: [number, number, number];
  size: number;
  zRange: [number, number];
  intensityRange: [number, number];
  attributes: string[];
  stride: number;
  classes: number[];
  crs: string;
  nodes: [number, number, number, number, number][];
}

export const GRID = 128; // sample cells per node edge, as in the tiler

export class Node {
  children: Node[] = [];
  points: THREE.Points | null = null;
  loading = false;
  failed = false;
  lastUsed = 0;
  deepestShown = 0; // finest level currently drawn in this node's region
  readonly box: THREE.Box3;
  readonly spacing: number; // rough distance between this node's points, metres

  constructor(
    readonly cloud: Cloud,
    readonly level: number,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly count: number,
  ) {
    const s = cloud.meta.size / (1 << level);
    this.box = new THREE.Box3(new THREE.Vector3(x * s, y * s, z * s), new THREE.Vector3((x + 1) * s, (y + 1) * s, (z + 1) * s));
    this.spacing = s / GRID;
  }

  get name() { return `${this.level}-${this.x}-${this.y}-${this.z}`; }
}

export class Cloud {
  readonly root: Node;
  readonly all: Node[];
  readonly hasRgb: boolean;
  readonly group = new THREE.Group();

  constructor(readonly url: string, readonly meta: CloudMeta, readonly material: THREE.ShaderMaterial) {
    this.hasRgb = meta.attributes.some((a) => a.startsWith('rgb'));
    const byName = new Map<string, Node>();
    this.all = meta.nodes.map(([l, x, y, z, n]) => {
      const node = new Node(this, l, x, y, z, n);
      byName.set(node.name, node);
      return node;
    });
    for (const n of this.all) {
      if (n.level === 0) continue;
      const parentName = `${n.level - 1}-${n.x >> 1}-${n.y >> 1}-${n.z >> 1}`;
      byName.get(parentName)?.children.push(n);
    }
    this.root = byName.get('0-0-0-0')!;
  }

  static async open(url: string, material: THREE.ShaderMaterial): Promise<Cloud> {
    const res = await fetch(`${url}/cloud.json`);
    if (!res.ok) throw new Error(`couldn't load ${url}/cloud.json (HTTP ${res.status})`);
    return new Cloud(url, await res.json(), material);
  }

  async load(node: Node): Promise<void> {
    node.loading = true;
    try {
      const res = await fetch(`${this.url}/n/${node.name}.bin`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      node.points = this.decode(node, buf);
      this.group.add(node.points);
    } catch (e) {
      node.failed = true;
      console.warn(`node ${node.name}:`, e);
    } finally {
      node.loading = false;
    }
  }

  unload(node: Node) {
    if (!node.points) return;
    this.group.remove(node.points);
    node.points.geometry.dispose();
    node.points = null;
  }

  private decode(node: Node, buf: Uint8Array): THREE.Points {
    const { stride } = this.meta;
    const n = buf.length / stride;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const pos = new Float32Array(n * 3);
    const cls = new Float32Array(n);
    const inten = new Float32Array(n);
    const rgb = this.hasRgb ? new Uint8Array(n * 3) : null;
    const s = this.meta.size / (1 << node.level) / 65535;
    const ox = node.box.min.x, oy = node.box.min.y, oz = node.box.min.z;
    for (let i = 0, o = 0; i < n; i++, o += stride) {
      pos[i * 3] = ox + dv.getUint16(o, true) * s;
      pos[i * 3 + 1] = oy + dv.getUint16(o + 2, true) * s;
      pos[i * 3 + 2] = oz + dv.getUint16(o + 4, true) * s;
      cls[i] = buf[o + 6];
      inten[i] = dv.getUint16(o + 7, true);
      if (rgb) { rgb[i * 3] = buf[o + 9]; rgb[i * 3 + 1] = buf[o + 10]; rgb[i * 3 + 2] = buf[o + 11]; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('classification', new THREE.BufferAttribute(cls, 1));
    g.setAttribute('intensity', new THREE.BufferAttribute(inten, 1));
    if (rgb) g.setAttribute('rgb', new THREE.BufferAttribute(rgb, 3, true));
    g.boundingBox = node.box.clone();
    g.boundingSphere = node.box.getBoundingSphere(new THREE.Sphere());
    const pts = new THREE.Points(g, this.material);
    pts.frustumCulled = false; // the LOD pass already culled by node
    pts.onBeforeRender = () => {
      this.material.uniforms.spacing.value = this.meta.size / (1 << node.deepestShown) / GRID;
      this.material.uniformsNeedUpdate = true;
    };
    pts.userData.node = node;
    return pts;
  }
}
