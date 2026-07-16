import type { PointerEvent as RPE } from 'react';
import type { NodeType } from './engine';
import { CATALOG } from './nodes';

/** Left rail: draggable component chips. Drag logic lives in Studio. */
export function Palette({
  onChipPointerDown,
}: {
  onChipPointerDown: (type: NodeType, e: RPE) => void;
}) {
  return (
    <div className="studio-palette">
      <p className="palette-head">Components</p>
      {CATALOG.map((c) => (
        <button
          key={c.type}
          type="button"
          className="palette-chip"
          onPointerDown={(e) => onChipPointerDown(c.type, e)}
          aria-label={`Add ${c.label}`}
        >
          <span className="chip-label">{c.label}</span>
          <span className="chip-blurb">{c.blurb}</span>
        </button>
      ))}
    </div>
  );
}
