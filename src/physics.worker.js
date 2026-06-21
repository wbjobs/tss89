import * as CANNON from 'cannon-es';

let world = null;
let particles = [];
let constraints = [];
let clothConfig = null;
let isPaused = false;
let windForce = new CANNON.Vec3(0, 0, 0);
let windStrength = 1;
let draggedParticleIndex = -1;
let dragTarget = new CANNON.Vec3();
let smoothedDragTarget = new CANNON.Vec3();
let sharedPositions = null;
let sharedPositionsView = null;
let colliderBody = null;
let colliderDragging = false;
let colliderDragTarget = new CANNON.Vec3();
let smoothedColliderTarget = new CANNON.Vec3();
let cutCounter = 0;

const CLOTH_WIDTH = 10;
const CLOTH_HEIGHT = 10;
const SEGMENTS_X = 20;
const SEGMENTS_Y = 20;
const SPACING_X = CLOTH_WIDTH / SEGMENTS_X;
const SPACING_Y = CLOTH_HEIGHT / SEGMENTS_Y;
const MAX_VELOCITY = 15;
const MAX_WIND_FORCE = 20;
const SOLVER_ITERATIONS = 60;
const DRAG_SMOOTHING = 0.2;
const COLLIDER_RADIUS = 1.8;

function initCloth(config) {
  clothConfig = config;
  
  world = new CANNON.World({
    gravity: new CANNON.Vec3(0, config.gravity, 0)
  });
  
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = SOLVER_ITERATIONS;
  world.solver.tolerance = 0;
  world.allowSleep = false;
  
  particles = [];
  constraints = [];
  cutCounter = 0;
  
  const particleMass = 0.1;
  
  for (let y = 0; y <= SEGMENTS_Y; y++) {
    for (let x = 0; x <= SEGMENTS_X; x++) {
      const px = (x - SEGMENTS_X / 2) * SPACING_X;
      const py = 8;
      const pz = (y - SEGMENTS_Y / 2) * SPACING_Y;
      
      const isCorner = (x === 0 && y === 0) || 
                       (x === SEGMENTS_X && y === 0) || 
                       (x === 0 && y === SEGMENTS_Y) || 
                       (x === SEGMENTS_X && y === SEGMENTS_Y);
      
      const particle = new CANNON.Body({
        mass: isCorner ? 0 : particleMass,
        position: new CANNON.Vec3(px, py, pz),
        linearDamping: config.damping,
        angularDamping: 0.9,
        shape: new CANNON.Sphere(0.08)
      });
      
      particle.collisionFilterGroup = 2;
      particle.collisionFilterMask = 1 | 4;
      particle.particleIndex = y * (SEGMENTS_X + 1) + x;
      
      if (isCorner) {
        particle.type = CANNON.Body.STATIC;
      }
      
      world.addBody(particle);
      particles.push(particle);
    }
  }
  
  createConstraints(config.stiffness);
  createCollider();
  
  const ground = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    position: new CANNON.Vec3(0, -5, 0)
  });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.collisionFilterGroup = 1;
  ground.collisionFilterMask = 2;
  world.addBody(ground);
  
  initSharedMemory();
  sendPositions();
  sendColliderInfo();
}

function createCollider() {
  colliderBody = new CANNON.Body({
    mass: 2,
    shape: new CANNON.Sphere(COLLIDER_RADIUS),
    position: new CANNON.Vec3(0, 3, 0),
    linearDamping: 0.3,
    angularDamping: 0.5,
    material: new CANNON.Material({ friction: 0.5, restitution: 0.1 })
  });
  colliderBody.collisionFilterGroup = 4;
  colliderBody.collisionFilterMask = 2 | 1;
  world.addBody(colliderBody);
}

function initSharedMemory() {
  if (typeof SharedArrayBuffer !== 'undefined') {
    try {
      const byteLength = particles.length * 3 * 4;
      sharedPositions = new SharedArrayBuffer(byteLength);
      sharedPositionsView = new Float32Array(sharedPositions);
    } catch (e) {
      console.warn('SharedArrayBuffer not available, falling back to transferable objects');
      sharedPositions = null;
    }
  }
}

function createConstraints(stiffness) {
  constraints.forEach(c => {
    try { world.removeConstraint(c); } catch(e) {}
  });
  constraints = [];
  
  const maxForce = stiffness * 10;
  
  for (let y = 0; y <= SEGMENTS_Y; y++) {
    for (let x = 0; x <= SEGMENTS_X; x++) {
      const index = y * (SEGMENTS_X + 1) + x;
      
      if (x < SEGMENTS_X) {
        const rightIndex = y * (SEGMENTS_X + 1) + (x + 1);
        const distConstraint = new CANNON.DistanceConstraint(
          particles[index],
          particles[rightIndex],
          SPACING_X,
          stiffness
        );
        distConstraint.maxForce = maxForce;
        distConstraint.userData = {
          type: 'horizontal',
          from: index,
          to: rightIndex,
          fromX: x, fromY: y,
          toX: x + 1, toY: y,
          id: `h_${x}_${y}`,
          cut: false
        };
        world.addConstraint(distConstraint);
        constraints.push(distConstraint);
      }
      
      if (y < SEGMENTS_Y) {
        const bottomIndex = (y + 1) * (SEGMENTS_X + 1) + x;
        const distConstraint = new CANNON.DistanceConstraint(
          particles[index],
          particles[bottomIndex],
          SPACING_Y,
          stiffness
        );
        distConstraint.maxForce = maxForce;
        distConstraint.userData = {
          type: 'vertical',
          from: index,
          to: bottomIndex,
          fromX: x, fromY: y,
          toX: x, toY: y + 1,
          id: `v_${x}_${y}`,
          cut: false
        };
        world.addConstraint(distConstraint);
        constraints.push(distConstraint);
      }
      
      if (x < SEGMENTS_X && y < SEGMENTS_Y) {
        const diagIndex = (y + 1) * (SEGMENTS_X + 1) + (x + 1);
        const diagDist = Math.sqrt(SPACING_X * SPACING_X + SPACING_Y * SPACING_Y);
        const diagConstraint = new CANNON.DistanceConstraint(
          particles[index],
          particles[diagIndex],
          diagDist,
          stiffness * 0.7
        );
        diagConstraint.maxForce = maxForce * 0.7;
        diagConstraint.userData = {
          type: 'diagDR',
          from: index,
          to: diagIndex,
          fromX: x, fromY: y,
          toX: x + 1, toY: y + 1,
          id: `ddr_${x}_${y}`,
          cut: false
        };
        world.addConstraint(diagConstraint);
        constraints.push(diagConstraint);
      }
      
      if (x > 0 && y < SEGMENTS_Y) {
        const diagIndex2 = (y + 1) * (SEGMENTS_X + 1) + (x - 1);
        const diagDist2 = Math.sqrt(SPACING_X * SPACING_X + SPACING_Y * SPACING_Y);
        const diagConstraint2 = new CANNON.DistanceConstraint(
          particles[index],
          particles[diagIndex2],
          diagDist2,
          stiffness * 0.7
        );
        diagConstraint2.maxForce = maxForce * 0.7;
        diagConstraint2.userData = {
          type: 'diagDL',
          from: index,
          to: diagIndex2,
          fromX: x, fromY: y,
          toX: x - 1, toY: y + 1,
          id: `ddl_${x}_${y}`,
          cut: false
        };
        world.addConstraint(diagConstraint2);
        constraints.push(diagConstraint2);
      }
    }
  }
}

function performCut(cutPoints) {
  if (cutPoints.length < 2) return 0;
  
  let removedCount = 0;
  const toRemove = [];
  
  for (const cp of cutPoints) {
    cp.x = cp.x / SEGMENTS_X;
    cp.y = cp.y / SEGMENTS_Y;
  }
  
  for (let ci = 0; ci < constraints.length; ci++) {
    const c = constraints[ci];
    if (!c.userData || c.userData.cut) continue;
    
    const fromX = c.userData.fromX / SEGMENTS_X;
    const fromY = c.userData.fromY / SEGMENTS_Y;
    const toX = c.userData.toX / SEGMENTS_X;
    const toY = c.userData.toY / SEGMENTS_Y;
    
    for (let i = 0; i < cutPoints.length - 1; i++) {
      const p1 = cutPoints[i];
      const p2 = cutPoints[i + 1];
      
      if (segmentsIntersect(
        fromX, fromY, toX, toY,
        p1.x, p1.y, p2.x, p2.y
      )) {
        toRemove.push(ci);
        c.userData.cut = true;
        removedCount++;
        break;
      }
    }
  }
  
  for (let i = toRemove.length - 1; i >= 0; i--) {
    try {
      world.removeConstraint(constraints[toRemove[i]]);
    } catch(e) {}
    constraints.splice(toRemove[i], 1);
  }
  
  cutCounter += removedCount;
  
  self.postMessage({
    type: 'cutResult',
    removed: removedCount,
    totalCuts: cutCounter
  });
  
  return removedCount;
}

function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 0.00001) return false;
  
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  
  const margin = 0.02;
  return t >= -margin && t <= 1 + margin && u >= -margin && u <= 1 + margin;
}

function clampVelocity(particle) {
  const vel = particle.velocity;
  const speed = vel.length();
  
  if (speed > MAX_VELOCITY) {
    vel.scale(MAX_VELOCITY / speed, vel);
  }
}

function applyWind() {
  const wind = windForce.scale(windStrength);
  const windLen = wind.length();
  
  if (windLen < 0.01) return;
  
  const clampedWind = windLen > MAX_WIND_FORCE 
    ? wind.scale(MAX_WIND_FORCE / windLen) 
    : wind;
  
  for (let y = 0; y < SEGMENTS_Y; y++) {
    for (let x = 0; x < SEGMENTS_X; x++) {
      const i00 = y * (SEGMENTS_X + 1) + x;
      const i10 = y * (SEGMENTS_X + 1) + (x + 1);
      const i01 = (y + 1) * (SEGMENTS_X + 1) + x;
      const i11 = (y + 1) * (SEGMENTS_X + 1) + (x + 1);
      
      const p00 = particles[i00].position;
      const p10 = particles[i10].position;
      const p01 = particles[i01].position;
      const p11 = particles[i11].position;
      
      const edge1 = new CANNON.Vec3().subVectors(p10, p00);
      const edge2 = new CANNON.Vec3().subVectors(p01, p00);
      const normal = new CANNON.Vec3().crossVectors(edge1, edge2);
      const normalLen = normal.length();
      
      if (normalLen < 0.0001) continue;
      
      normal.scale(1 / normalLen, normal);
      
      const area = normalLen * 0.5;
      const forceMagnitude = clampedWind.dot(normal) * area;
      const force = normal.scale(forceMagnitude);
      
      const quarterForce = force.scale(0.25);
      
      if (particles[i00].mass > 0) particles[i00].applyForce(quarterForce, p00);
      if (particles[i10].mass > 0) particles[i10].applyForce(quarterForce, p10);
      if (particles[i01].mass > 0) particles[i01].applyForce(quarterForce, p01);
      if (particles[i11].mass > 0) particles[i11].applyForce(quarterForce, p11);
    }
  }
}

function updateDrag() {
  if (draggedParticleIndex >= 0 && draggedParticleIndex < particles.length) {
    const particle = particles[draggedParticleIndex];
    
    smoothedDragTarget.x += (dragTarget.x - smoothedDragTarget.x) * DRAG_SMOOTHING;
    smoothedDragTarget.y += (dragTarget.y - smoothedDragTarget.y) * DRAG_SMOOTHING;
    smoothedDragTarget.z += (dragTarget.z - smoothedDragTarget.z) * DRAG_SMOOTHING;
    
    const currentPos = particle.position;
    const targetPos = smoothedDragTarget;
    
    const diff = new CANNON.Vec3().subVectors(targetPos, currentPos);
    const dist = diff.length();
    
    const maxDist = 3;
    if (dist > maxDist) {
      diff.scale(maxDist / dist, diff);
      targetPos.vadd(currentPos, diff);
    }
    
    const kp = 500;
    const kd = 30;
    const vel = particle.velocity;
    
    const force = diff.scale(kp).vsub(vel.scale(kd));
    
    const maxForce = 500;
    const forceLen = force.length();
    if (forceLen > maxForce) {
      force.scale(maxForce / forceLen, force);
    }
    
    particle.applyForce(force, currentPos);
    clampVelocity(particle);
  }
}

function updateColliderDrag() {
  if (colliderDragging && colliderBody) {
    smoothedColliderTarget.x += (colliderDragTarget.x - smoothedColliderTarget.x) * 0.3;
    smoothedColliderTarget.y += (colliderDragTarget.y - smoothedColliderTarget.y) * 0.3;
    smoothedColliderTarget.z += (colliderDragTarget.z - smoothedColliderTarget.z) * 0.3;
    
    const currentPos = colliderBody.position;
    const diff = new CANNON.Vec3().subVectors(smoothedColliderTarget, currentPos);
    const vel = colliderBody.velocity;
    
    const kp = 800;
    const kd = 50;
    
    const force = diff.scale(kp).vsub(vel.scale(kd));
    
    const maxForce = 2000;
    const forceLen = force.length();
    if (forceLen > maxForce) {
      force.scale(maxForce / forceLen, force);
    }
    
    colliderBody.applyForce(force, currentPos);
    
    const colliderVel = colliderBody.velocity;
    const speed = colliderVel.length();
    if (speed > 20) {
      colliderVel.scale(20 / speed, colliderVel);
    }
  }
}

function sendPositions() {
  if (sharedPositions && sharedPositionsView) {
    for (let i = 0; i < particles.length; i++) {
      const pos = particles[i].position;
      sharedPositionsView[i * 3] = pos.x;
      sharedPositionsView[i * 3 + 1] = pos.y;
      sharedPositionsView[i * 3 + 2] = pos.z;
    }
    
    self.postMessage({
      type: 'positions',
      shared: true,
      segmentsX: SEGMENTS_X,
      segmentsY: SEGMENTS_Y
    });
  } else {
    const positions = new Float32Array(particles.length * 3);
    
    for (let i = 0; i < particles.length; i++) {
      const pos = particles[i].position;
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
    }
    
    self.postMessage({
      type: 'positions',
      positions: positions.buffer,
      shared: false,
      segmentsX: SEGMENTS_X,
      segmentsY: SEGMENTS_Y
    }, [positions.buffer]);
  }
}

function sendColliderInfo() {
  if (colliderBody) {
    self.postMessage({
      type: 'collider',
      position: {
        x: colliderBody.position.x,
        y: colliderBody.position.y,
        z: colliderBody.position.z
      },
      radius: COLLIDER_RADIUS
    });
  }
}

function sendColliderPosition() {
  if (colliderBody) {
    self.postMessage({
      type: 'colliderPos',
      x: colliderBody.position.x,
      y: colliderBody.position.y,
      z: colliderBody.position.z
    });
  }
}

let lastTime = performance.now();
let frameCount = 0;
let lastColliderSendTime = 0;

function simulate() {
  if (!isPaused && world) {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    
    applyWind();
    updateDrag();
    updateColliderDrag();
    
    world.step(1 / 60, dt, 4);
    
    particles.forEach(p => {
      if (p.mass > 0) {
        clampVelocity(p);
      }
    });
    
    frameCount++;
    if (frameCount % 2 === 0) {
      sendPositions();
    }
    
    if (now - lastColliderSendTime > 33) {
      sendColliderPosition();
      lastColliderSendTime = now;
    }
  } else {
    lastTime = performance.now();
  }
  
  requestAnimationFrame(simulate);
}

self.onmessage = function(e) {
  const message = e.data;
  
  switch (message.type) {
    case 'init':
      initCloth(message.config);
      if (sharedPositions) {
        self.postMessage({
          type: 'sharedMemory',
          buffer: sharedPositions,
          length: particles.length * 3
        });
      }
      simulate();
      break;
      
    case 'gravity':
      if (world) {
        world.gravity.y = message.value;
      }
      break;
      
    case 'wind':
      windForce.set(message.x, message.y, message.z);
      break;
      
    case 'windStrength':
      windStrength = message.value;
      break;
      
    case 'stiffness':
      if (clothConfig) {
        clothConfig.stiffness = message.value;
        const existingCuts = constraints.filter(c => c.userData && c.userData.cut).length;
        createConstraints(message.value);
      }
      break;
      
    case 'damping':
      particles.forEach(p => {
        if (p.mass > 0) {
          p.linearDamping = message.value;
        }
      });
      break;
      
    case 'dragStart':
      draggedParticleIndex = message.index;
      if (draggedParticleIndex >= 0 && draggedParticleIndex < particles.length) {
        const pos = particles[draggedParticleIndex].position;
        dragTarget.copy(pos);
        smoothedDragTarget.copy(pos);
      }
      break;
      
    case 'dragMove':
      dragTarget.set(message.x, message.y, message.z);
      break;
      
    case 'dragEnd':
      draggedParticleIndex = -1;
      break;
      
    case 'colliderDragStart':
      colliderDragging = true;
      if (colliderBody) {
        colliderDragTarget.copy(colliderBody.position);
        smoothedColliderTarget.copy(colliderBody.position);
      }
      break;
      
    case 'colliderDragMove':
      colliderDragTarget.set(message.x, message.y, message.z);
      break;
      
    case 'colliderDragEnd':
      colliderDragging = false;
      break;
      
    case 'cut':
      performCut(message.points);
      break;
      
    case 'pause':
      isPaused = message.value;
      break;
      
    case 'reset':
      draggedParticleIndex = -1;
      colliderDragging = false;
      isPaused = false;
      
      particles.forEach((p, i) => {
        const x = i % (SEGMENTS_X + 1);
        const y = Math.floor(i / (SEGMENTS_X + 1));
        const px = (x - SEGMENTS_X / 2) * SPACING_X;
        const py = 8;
        const pz = (y - SEGMENTS_Y / 2) * SPACING_Y;
        
        p.position.set(px, py, pz);
        p.velocity.set(0, 0, 0);
        p.angularVelocity.set(0, 0, 0);
      });
      
      if (colliderBody) {
        colliderBody.position.set(0, 3, 0);
        colliderBody.velocity.set(0, 0, 0);
        colliderBody.angularVelocity.set(0, 0, 0);
        sendColliderInfo();
      }
      
      createConstraints(clothConfig.stiffness);
      sendPositions();
      break;
  }
};
