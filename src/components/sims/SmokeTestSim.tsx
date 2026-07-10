import { useRef, useState } from 'react';
import { SimFrame } from './SimFrame';
import { Slider } from './controls';
import { useRafLoop } from './hooks/useRafLoop';

const W = 640;
const H = 320;
const R = 12;

interface World {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
}

function initWorld(): World {
  return { x: W / 3, y: H / 3, vx: 1, vy: 0.7, bounces: 0 };
}

function stepWorld(w: World, dtMs: number, speed: number) {
  const k = speed * dtMs * 0.06;
  w.x += w.vx * k;
  w.y += w.vy * k;
  if (w.x < R || w.x > W - R) {
    w.vx *= -1;
    w.x = Math.max(R, Math.min(W - R, w.x));
    w.bounces++;
  }
  if (w.y < R || w.y > H - R) {
    w.vy *= -1;
    w.y = Math.max(R, Math.min(H - R, w.y));
    w.bounces++;
  }
}

/**
 * Smoke-test sim validating the shared pattern: pure step function,
 * world in a ref, params in state, one rAF loop, SimFrame chrome.
 * Replaced by the real LoadBalancingSim in a content wave.
 */
export default function SmokeTestSim() {
  const world = useRef<World>(initWorld());
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(4);
  const [, setTick] = useState(0);

  useRafLoop((dt) => {
    stepWorld(world.current, dt, speed);
    setTick((t) => t + 1);
  }, playing);

  const w = world.current;

  return (
    <SimFrame
      title="Simulation harness smoke test"
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onReset={() => {
        world.current = initWorld();
        setTick((t) => t + 1);
      }}
      controls={
        <Slider label="Speed" value={speed} min={1} max={10} onChange={setSpeed} />
      }
      readouts={[{ label: 'bounces', value: w.bounces }]}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="A dot bouncing inside a box">
        <rect
          x="1"
          y="1"
          width={W - 2}
          height={H - 2}
          rx="8"
          fill="none"
          stroke="var(--border)"
        />
        <circle cx={w.x} cy={w.y} r={R} fill="var(--accent)" />
      </svg>
    </SimFrame>
  );
}
