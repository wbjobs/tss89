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
        shape: new CANNON.Sphere(0.1)
      });
      
      particle.collisionFilterGroup = 2;
      particle.collisionFilterMask = 1;
      
      if (isCorner) {
        particle.type = CANNON.Body.STATIC;
      }
      
      world.addBody(particle);
      particles.push(particle);
    }
  }
  
  createConstraints(config.stiffness);
  
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
  constraints.forEach(c => world.removeConstraint(c));
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
        world.addConstraint(diagConstraint2);
        constraints.push(diagConstraint2);
      }
    }
  }
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

let lastTime = performance.now();
let frameCount = 0;

function simulate() {
  if (!isPaused && world) {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    
    applyWind();
    updateDrag();
    
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
      
    case 'pause':
      isPaused = message.value;
      break;
      
    case 'reset':
      draggedParticleIndex = -1;
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
      
      sendPositions();
      break;
  }
};
