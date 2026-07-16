import type { SimNode, Strategy } from './engine';
import type { ParamSpec } from './nodes';
import { INFO, STRATEGIES } from './nodes';
import { Slider, SegmentedControl } from '../sims/controls';

/** Right-rail parameter editor for the selected node. Reuses the sim control kit. */
export function Inspector({
  node,
  onParam,
  onStrategy,
}: {
  node: SimNode;
  onParam: (key: ParamSpec['key'], value: number) => void;
  onStrategy: (value: Strategy) => void;
}) {
  const info = INFO[node.type];
  return (
    <>
      <div className="rail-head">
        <h3>{info.label}</h3>
      </div>
      <p className="rail-note">{info.blurb}</p>
      {info.strategy && (
        <SegmentedControl<Strategy>
          label="Strategy"
          value={node.params.strategy}
          options={STRATEGIES}
          onChange={onStrategy}
        />
      )}
      {info.params.map((spec) => (
        <Slider
          key={spec.key}
          label={spec.label}
          value={node.params[spec.key]}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          format={spec.format}
          onChange={(v) => onParam(spec.key, v)}
        />
      ))}
      {info.params.length === 0 && !info.strategy && (
        <p className="rail-note">
          Traffic rate is set globally in the toolbar. Connect this source to a downstream component.
        </p>
      )}
    </>
  );
}
