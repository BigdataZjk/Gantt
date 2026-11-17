import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";

// Adapted from thegridcn (MIT): https://thegridcn.com/r/grid.json
const vertexShader = `
  varying vec3 vPosition;
  void main() {
    vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec3 vPosition;
  void main() {
    vec2 grid = abs(fract(vPosition.xz * 0.5 - 0.5) - 0.5) / fwidth(vPosition.xz * 0.5);
    float line = 1.0 - min(min(grid.x, grid.y), 1.0);
    float fade = 1.0 - smoothstep(0.0, 1.0, length(vPosition.xz) / 50.0);
    float pulse = sin(uTime * 2.0 - length(vPosition.xz) * 0.3) * 0.2 + 0.8;
    gl_FragColor = vec4(uColor, line * fade * pulse * 0.6);
    #include <colorspace_fragment>
  }
`;

const beamPositions = [[-8, 8, -5], [8, 8, -8], [0, 8, -12], [-5, 8, 5], [5, 8, 3]];

export function createGrid3D(root: HTMLElement, canvas: HTMLCanvasElement) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "high-performance" });
  } catch {
    return () => {};
  }

  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  const color = new Color(getComputedStyle(root).getPropertyValue("--grid-color").trim());
  const floorGeometry = new PlaneGeometry(100, 100);
  const floorMaterial = new ShaderMaterial({
    uniforms: { uColor: { value: color }, uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
  });
  const floor = new Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2;
  scene.add(floor);

  const count = 100;
  const positions = new Float32Array(count * 3);
  const initialY = new Float32Array(count);
  let seed = 23;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (random() - 0.5) * 40;
    positions[index * 3 + 1] = random() * 20 - 2;
    positions[index * 3 + 2] = (random() - 0.5) * 40;
    initialY[index] = positions[index * 3 + 1];
  }
  const particleGeometry = new BufferGeometry();
  const particleAttribute = new BufferAttribute(positions, 3);
  particleGeometry.setAttribute("position", particleAttribute);
  const particleMaterial = new PointsMaterial({ color, size: 0.05, transparent: true, opacity: 0.8, sizeAttenuation: true, depthWrite: false });
  const particles = new Points(particleGeometry, particleMaterial);
  scene.add(particles);

  const beamGeometry = new CylinderGeometry(0.02, 0.02, 20, 6);
  const beamMaterial = new MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false });
  const beams = new InstancedMesh(beamGeometry, beamMaterial, beamPositions.length);
  const matrix = new Matrix4();
  beamPositions.forEach(([x, y, z], index) => {
    matrix.setPosition(x, y, z);
    beams.setMatrixAt(index, matrix);
  });
  beams.instanceMatrix.needsUpdate = true;
  scene.add(beams);

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let time = 0;
  let lastFrame = 0;
  let frameId = 0;
  let disposed = false;

  const render = () => {
    floorMaterial.uniforms.uTime.value = time;
    camera.position.set(Math.sin(time * 0.1) * 2, 5, 10 + Math.cos(time * 0.1) * 2);
    camera.lookAt(0, 0, 0);
    particles.rotation.y = time * 0.02;
    for (let index = 0; index < count; index += 1) {
      positions[index * 3 + 1] = initialY[index] + Math.sin(time + index * 0.1) * 0.5;
    }
    particleAttribute.needsUpdate = true;
    beamMaterial.opacity = 0.3 + Math.sin(time * 3) * 0.15;
    renderer.render(scene, camera);
  };

  const resize = () => {
    const { width, height } = root.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1, Math.sqrt(1000000 / (width * height))));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };

  const frame = (now: number) => {
    if (disposed) return;
    if (now - lastFrame < 1000 / 30 - 1) {
      frameId = requestAnimationFrame(frame);
      return;
    }
    time += Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    render();
    frameId = requestAnimationFrame(frame);
  };

  const updateMotion = () => {
    cancelAnimationFrame(frameId);
    frameId = 0;
    root.dataset.motion = motion.matches ? "static" : "animated";
    root.dataset.paused = String(document.hidden);
    if (document.hidden || disposed || renderer.getContext().isContextLost()) return;
    render();
    if (!motion.matches) {
      lastFrame = performance.now();
      frameId = requestAnimationFrame(frame);
    }
  };

  const contextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(frameId);
    root.dataset.renderer = "fallback";
    root.dataset.motion = "static";
  };
  const contextRestored = () => {
    root.dataset.renderer = "webgl";
    updateMotion();
  };

  resize();
  root.dataset.renderer = "webgl";
  updateMotion();
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  motion.addEventListener("change", updateMotion);
  document.addEventListener("visibilitychange", updateMotion);
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);

  return () => {
    disposed = true;
    cancelAnimationFrame(frameId);
    observer.disconnect();
    motion.removeEventListener("change", updateMotion);
    document.removeEventListener("visibilitychange", updateMotion);
    canvas.removeEventListener("webglcontextlost", contextLost);
    canvas.removeEventListener("webglcontextrestored", contextRestored);
    floorGeometry.dispose();
    floorMaterial.dispose();
    particleGeometry.dispose();
    particleMaterial.dispose();
    beamGeometry.dispose();
    beamMaterial.dispose();
    beams.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };
}
