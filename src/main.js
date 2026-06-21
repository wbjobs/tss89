import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import PhysicsWorker from './physics.worker.js?worker';

let scene, camera, renderer, controls;
let clothMesh, clothGeometry;
let physicsWorker;
let raycaster, mouse;
let isDragging = false;
let draggedVertexIndex = -1;
let dragPlane = new THREE.Plane();
let dragOffset = new THREE.Vector3();
let intersectionPoint = new THREE.Vector3();
let segmentsX, segmentsY;
let isPaused = false;

const config = {
  gravity: -9.8,
  windX: 0,
  windY: 0,
  windZ: 0,
  windStrength: 1,
  stiffness: 10000,
  damping: 0.5
};

function init() {
  const canvas = document.getElementById('canvas');
  
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 20, 50);
  
  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 5, 18);
  
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 5;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI * 0.85;
  
  setupLights();
  createGround();
  createCloth();
  
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  
  setupWorker();
  setupEventListeners();
  setupControls();
  
  animate();
}

function setupLights() {
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);
  
  const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
  mainLight.position.set(10, 15, 10);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 2048;
  mainLight.shadow.mapSize.height = 2048;
  mainLight.shadow.camera.near = 0.5;
  mainLight.shadow.camera.far = 50;
  mainLight.shadow.camera.left = -15;
  mainLight.shadow.camera.right = 15;
  mainLight.shadow.camera.top = 15;
  mainLight.shadow.camera.bottom = -15;
  mainLight.shadow.bias = -0.0001;
  scene.add(mainLight);
  
  const fillLight = new THREE.DirectionalLight(0x60a5fa, 0.5);
  fillLight.position.set(-10, 5, -5);
  scene.add(fillLight);
  
  const rimLight = new THREE.DirectionalLight(0xfbbf24, 0.3);
  rimLight.position.set(0, 10, -10);
  scene.add(rimLight);
}

function createGround() {
  const groundGeometry = new THREE.PlaneGeometry(50, 50);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x2d3748,
    roughness: 0.9,
    metalness: 0.1
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -5;
  ground.receiveShadow = true;
  scene.add(ground);
  
  const gridHelper = new THREE.GridHelper(30, 30, 0x4a5568, 0x2d3748);
  gridHelper.position.y = -4.99;
  scene.add(gridHelper);
}

function createCloth() {
  const CLOTH_WIDTH = 10;
  const CLOTH_HEIGHT = 10;
  segmentsX = 20;
  segmentsY = 20;
  
  clothGeometry = new THREE.PlaneGeometry(
    CLOTH_WIDTH,
    CLOTH_HEIGHT,
    segmentsX,
    segmentsY
  );
  
  const positions = clothGeometry.attributes.position.array;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] += 8;
  }
  clothGeometry.attributes.position.needsUpdate = true;
  
  const uvs = clothGeometry.attributes.uv.array;
  for (let i = 0; i < uvs.length; i += 2) {
    const x = uvs[i];
    const y = uvs[i + 1];
    const stripe = Math.floor(x * 20) % 2 === 0 ? 1 : 0.7;
    uvs[i + 1] = y * stripe + (1 - y) * stripe;
  }
  
  const clothMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b82f6,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
    wireframe: false
  });
  
  clothMesh = new THREE.Mesh(clothGeometry, clothMaterial);
  clothMesh.castShadow = true;
  clothMesh.receiveShadow = true;
  scene.add(clothMesh);
  
  const wireframeMaterial = new THREE.MeshBasicMaterial({
    color: 0x60a5fa,
    wireframe: true,
    transparent: true,
    opacity: 0.2
  });
  const wireframe = new THREE.Mesh(clothGeometry, wireframeMaterial);
  clothMesh.add(wireframe);
  
  createCornerMarkers();
}

function createCornerMarkers() {
  const markerGeometry = new THREE.SphereGeometry(0.2, 16, 16);
  const markerMaterial = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    emissive: 0xef4444,
    emissiveIntensity: 0.5
  });
  
  const halfW = 5;
  const halfH = 5;
  const y = 8;
  
  const corners = [
    { x: -halfW, z: -halfH },
    { x: halfW, z: -halfH },
    { x: -halfW, z: halfH },
    { x: halfW, z: halfH }
  ];
  
  corners.forEach(corner => {
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    marker.position.set(corner.x, y, corner.z);
    scene.add(marker);
  });
}

function setupWorker() {
  physicsWorker = new PhysicsWorker();
  
  physicsWorker.postMessage({
    type: 'init',
    config: config
  });
  
  physicsWorker.onmessage = function(e) {
    if (e.data.type === 'positions') {
      const positions = new Float32Array(e.data.positions);
      updateClothPositions(positions);
    }
  };
}

function updateClothPositions(positions) {
  if (!clothGeometry) return;
  
  const geoPositions = clothGeometry.attributes.position.array;
  
  for (let i = 0; i < positions.length; i += 3) {
    const vertexIndex = i / 3;
    const geoX = vertexIndex % (segmentsX + 1);
    const geoY = Math.floor(vertexIndex / (segmentsX + 1));
    const geoIndex = (geoY * (segmentsX + 1) + geoX) * 3;
    
    geoPositions[geoIndex] = positions[i];
    geoPositions[geoIndex + 1] = positions[i + 1];
    geoPositions[geoIndex + 2] = positions[i + 2];
  }
  
  clothGeometry.attributes.position.needsUpdate = true;
  clothGeometry.computeVertexNormals();
}

function setupEventListeners() {
  window.addEventListener('resize', onWindowResize);
  
  const canvas = renderer.domElement;
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);
  
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
}

function getMousePosition(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function findNearestVertex() {
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(clothMesh);
  
  if (intersects.length > 0) {
    intersectionPoint.copy(intersects[0].point);
    
    const positions = clothGeometry.attributes.position.array;
    let minDist = Infinity;
    let nearestIndex = -1;
    
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      
      const dist = Math.sqrt(
        Math.pow(intersectionPoint.x - x, 2) +
        Math.pow(intersectionPoint.y - y, 2) +
        Math.pow(intersectionPoint.z - z, 2)
      );
      
      if (dist < minDist && dist < 1.5) {
        minDist = dist;
        nearestIndex = i / 3;
      }
    }
    
    return nearestIndex;
  }
  
  return -1;
}

function onMouseDown(event) {
  getMousePosition(event);
  
  const vertexIndex = findNearestVertex();
  if (vertexIndex >= 0) {
    const positions = clothGeometry.attributes.position.array;
    const vertexPos = new THREE.Vector3(
      positions[vertexIndex * 3],
      positions[vertexIndex * 3 + 1],
      positions[vertexIndex * 3 + 2]
    );
    
    const normal = new THREE.Vector3(0, 0, 1);
    normal.applyQuaternion(camera.quaternion);
    dragPlane.setFromNormalAndCoplanarPoint(normal, vertexPos);
    
    raycaster.setFromCamera(mouse, camera);
    raycaster.ray.intersectPlane(dragPlane, dragOffset);
    dragOffset.sub(vertexPos);
    
    isDragging = true;
    draggedVertexIndex = vertexIndex;
    controls.enabled = false;
    
    physicsWorker.postMessage({
      type: 'dragStart',
      index: vertexIndex
    });
  }
}

function onMouseMove(event) {
  getMousePosition(event);
  
  if (isDragging && draggedVertexIndex >= 0) {
    raycaster.setFromCamera(mouse, camera);
    
    if (raycaster.ray.intersectPlane(dragPlane, intersectionPoint)) {
      const targetPos = intersectionPoint.clone().sub(dragOffset);
      
      physicsWorker.postMessage({
        type: 'dragMove',
        x: targetPos.x,
        y: targetPos.y,
        z: targetPos.z
      });
    }
  }
}

function onMouseUp() {
  if (isDragging) {
    isDragging = false;
    draggedVertexIndex = -1;
    controls.enabled = true;
    
    physicsWorker.postMessage({
      type: 'dragEnd'
    });
  }
}

function onTouchStart(event) {
  event.preventDefault();
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    onMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
  }
}

function onTouchMove(event) {
  event.preventDefault();
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
  }
}

function onTouchEnd(event) {
  event.preventDefault();
  onMouseUp();
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function setupControls() {
  const gravitySlider = document.getElementById('gravity');
  const gravityValue = document.getElementById('gravity-value');
  gravitySlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    config.gravity = value;
    gravityValue.textContent = value.toFixed(1);
    physicsWorker.postMessage({ type: 'gravity', value });
  });
  
  const windXSlider = document.getElementById('wind-x');
  const windXValue = document.getElementById('wind-x-value');
  windXSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    config.windX = value;
    windXValue.textContent = value;
    updateWind();
  });
  
  const windYSlider = document.getElementById('wind-y');
  const windYValue = document.getElementById('wind-y-value');
  windYSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    config.windY = value;
    windYValue.textContent = value;
    updateWind();
  });
  
  const windZSlider = document.getElementById('wind-z');
  const windZValue = document.getElementById('wind-z-value');
  windZSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    config.windZ = value;
    windZValue.textContent = value;
    updateWind();
  });
  
  const windStrengthSlider = document.getElementById('wind-strength');
  const windStrengthValue = document.getElementById('wind-strength-value');
  windStrengthSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    config.windStrength = value;
    windStrengthValue.textContent = value.toFixed(1);
    physicsWorker.postMessage({ type: 'windStrength', value });
  });
  
  const stiffnessSlider = document.getElementById('stiffness');
  const stiffnessValue = document.getElementById('stiffness-value');
  stiffnessSlider.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    config.stiffness = value;
    stiffnessValue.textContent = value;
    physicsWorker.postMessage({ type: 'stiffness', value });
  });
  
  const dampingSlider = document.getElementById('damping');
  const dampingValue = document.getElementById('damping-value');
  dampingSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    config.damping = value;
    dampingValue.textContent = value.toFixed(2);
    physicsWorker.postMessage({ type: 'damping', value });
  });
  
  document.getElementById('reset-btn').addEventListener('click', () => {
    physicsWorker.postMessage({ type: 'reset' });
    isPaused = false;
    updateStatus();
  });
  
  document.getElementById('pause-btn').addEventListener('click', () => {
    isPaused = !isPaused;
    physicsWorker.postMessage({ type: 'pause', value: isPaused });
    updateStatus();
  });
}

function updateWind() {
  physicsWorker.postMessage({
    type: 'wind',
    x: config.windX,
    y: config.windY,
    z: config.windZ
  });
}

function updateStatus() {
  const statusEl = document.getElementById('status');
  if (isPaused) {
    statusEl.textContent = '状态: 已暂停';
    statusEl.classList.add('paused');
  } else {
    statusEl.textContent = '状态: 运行中';
    statusEl.classList.remove('paused');
  }
}

function animate() {
  requestAnimationFrame(animate);
  
  controls.update();
  renderer.render(scene, camera);
}

init();
