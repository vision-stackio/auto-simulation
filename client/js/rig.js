export const Rig = (function () {
  const mount = document.getElementById("stage3d");
  const loadingEl = document.getElementById("modelLoading");

  let scene, camera, renderer, root, model;
  let radius = 1;
  let modelHeight = 1;
  const view = { theta: 0, phi: Math.PI * 0.48, dist: 3 };
  const target = new THREE.Vector3();
  let t = 0;

  const mode = { walking: false, walkDir: 1, dancing: false, stopped: false };
  let bodyTurnDeg = 0;
  let eyeAngleDeg = 90;
  let idleNudgeDeg = 0; // subtle extra offset while the mic hears someone talking

  function parseOBJ(text) {
    const lines = text.split("\n");
    const positions = [];
    const colors = [];
    const faces = [];
    let hasColor = false;
    let sumX = 0, sumY = 0, sumZ = 0, n = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.charCodeAt(0) === 118 && line.charCodeAt(1) === 32) {
        // "v "
        const p = line.trim().split(/\s+/);
        const vx = parseFloat(p[1]), vy = parseFloat(p[2]), vz = parseFloat(p[3]);
        positions.push(vx, vy, vz);
        sumX += vx; sumY += vy; sumZ += vz; n++;
        if (p.length >= 7) {
          hasColor = true;
          colors.push(parseFloat(p[4]), parseFloat(p[5]), parseFloat(p[6]));
        } else {
          colors.push(0.75, 0.75, 0.75);
        }
      } else if (line.charCodeAt(0) === 102 && line.charCodeAt(1) === 32) {
        // "f "
        const f = line.trim().split(/\s+/);
        for (let k = 1; k < f.length; k++) faces.push(parseInt(f[k].split("/")[0], 10) - 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (hasColor) geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    if (faces.length) geo.setIndex(faces);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return { geo, hasColor, centroid: n ? { x: sumX / n, y: sumY / n, z: sumZ / n } : { x: 0, y: 0, z: 0 } };
  }

  function updateCamera() {
    const midY = modelHeight * 0.5;
    const x = target.x + view.dist * Math.sin(view.phi) * Math.sin(view.theta);
    const y = target.y + midY + view.dist * Math.cos(view.phi);
    const z = target.z + view.dist * Math.sin(view.phi) * Math.cos(view.theta);
    camera.position.set(x, y, z);
    camera.lookAt(target.x, target.y + midY, target.z);
  }

  function bindControls() {
    let dragging = false, lx = 0, ly = 0;
    function down(x, y) { dragging = true; lx = x; ly = y; mount.style.cursor = "grabbing"; }
    function move(x, y) {
      if (!dragging) return;
      const dx = x - lx, dy = y - ly; lx = x; ly = y;
      view.theta -= dx * 0.008;
      view.phi = Math.max(0.25, Math.min(Math.PI / 1.55, view.phi - dy * 0.008));
      updateCamera();
    }
    function up() { dragging = false; mount.style.cursor = "grab"; }
    mount.addEventListener("mousedown", (e) => down(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
    window.addEventListener("mouseup", up);
    mount.addEventListener("wheel", (e) => {
      e.preventDefault();
      view.dist = Math.max(radius * 0.55, Math.min(radius * 7, view.dist * (1 + e.deltaY * 0.001)));
      updateCamera();
    }, { passive: false });
    mount.addEventListener("touchstart", (e) => { if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    mount.addEventListener("touchmove", (e) => { if (e.touches.length === 1) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
    mount.addEventListener("touchend", up);
  }

  function onResize() {
    if (!mount.clientWidth) return;
    camera.aspect = mount.clientWidth / mount.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(mount.clientWidth, mount.clientHeight);
  }

  function loop() {
    requestAnimationFrame(loop);
    t += 0.016;

    if (model && !mode.stopped) {
      let bob = 0, sway = 0, lean = 0;
      if (mode.dancing) {
        bob = Math.abs(Math.sin(t * 7.8)) * radius * 0.09;
        sway = Math.sin(t * 7.8) * 0.22;
        lean = Math.sin(t * 3.9) * 0.09;
      } else if (mode.walking) {
        bob = Math.abs(Math.sin(t * 8.5)) * radius * 0.035;
        sway = Math.sin(t * 4.25) * 0.035;
        // Move across the grid in the direction the body is facing
        const yaw = (bodyTurnDeg * Math.PI) / 180;
        const speed = radius * 0.045 * mode.walkDir; // units per frame (~60fps)
        root.position.x += Math.sin(yaw) * speed;
        root.position.z += Math.cos(yaw) * speed;
      }
      const eyeYaw = ((eyeAngleDeg + idleNudgeDeg - 90) / 90) * 0.28;
      root.rotation.y = Math.PI + (bodyTurnDeg * Math.PI) / 180 + eyeYaw * 0.4;
      root.rotation.z = sway;
      root.rotation.x = lean;
      root.position.y = bob;
      // Keep orbit camera centered on the robot as it moves
      target.x = root.position.x;
      target.z = root.position.z;
      updateCamera();
    } else if (model && mode.stopped) {
      root.rotation.z *= 0.9;
      root.rotation.x *= 0.9;
      root.position.y *= 0.85;
    }
    renderer.render(scene, camera);
  }

  async function init() {
    scene = new THREE.Scene();
    scene.background = null;
    camera = new THREE.PerspectiveCamera(40, mount.clientWidth / mount.clientHeight, 0.01, 100);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(2.2, 4.2, 3); scene.add(key);
    const rim = new THREE.DirectionalLight(0xaaaaaa, 0.35); rim.position.set(-3, 1.2, -2.2); scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25); fill.position.set(0, -1, 2); scene.add(fill);

    root = new THREE.Group();
    scene.add(root);

    try {
      const res = await fetch("/assets/model/robot.obj");
      if (!res.ok) throw new Error("model fetch failed: " + res.status);
      const raw = await res.text();
      const parsed = parseOBJ(raw);

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: parsed.hasColor,
        color: parsed.hasColor ? 0xffffff : 0xaab0bb,
        metalness: 0.08,
        roughness: 0.72,
        side: THREE.DoubleSide,
      });
      model = new THREE.Mesh(parsed.geo, mat);

      const s = new THREE.Vector3();
      parsed.geo.boundingBox.getSize(s);
      radius = parsed.geo.boundingSphere.radius || Math.max(s.x, s.y, s.z) || 1;
      model.position.set(-parsed.centroid.x, -parsed.geo.boundingBox.min.y, -parsed.centroid.z);
      root.add(model);

      const gridSize = 80, gridDivs = 80;
      const grid = new THREE.GridHelper(gridSize, gridDivs, 0x2e2e32, 0x18181a);
      const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
      mats.forEach((m) => { m.transparent = true; m.opacity = 0.9; m.depthWrite = false; });
      scene.add(grid);

      const floorGeo = new THREE.PlaneGeometry(gridSize * 2, gridSize * 2);
      floorGeo.rotateX(-Math.PI / 2);
      const floorMat = new THREE.MeshBasicMaterial({ color: 0x080809, transparent: true, opacity: 0.92, depthWrite: false });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.position.y = -0.01;
      scene.add(floorMesh);

      modelHeight = s.y;
      view.dist = radius / Math.sin(((camera.fov * Math.PI) / 180) / 2) * 1.05;
      loadingEl.style.display = "none";
    } catch (e) {
      loadingEl.textContent = "Could not load 3D model";
      console.error(e);
      throw e;
    }

    updateCamera();
    bindControls();
    window.addEventListener("resize", onResize);
    requestAnimationFrame(loop);
  }

  const ready = init();

  return {
    ready,
    setEyeAngle: (deg) => { eyeAngleDeg = deg; },
    setIdleNudge: (deg) => { idleNudgeDeg = deg; },
    setBodyTurn: (deg) => { bodyTurnDeg = deg; },
    setWalking: (v, dir = 1) => { mode.walking = !!v; mode.walkDir = dir >= 0 ? 1 : -1; },
    setDancing: (v) => { mode.dancing = v; },
    setStopped: (v) => { mode.stopped = v; },
    getEyeAngle: () => eyeAngleDeg,
    getBodyTurn: () => bodyTurnDeg,
  };
})();
