import type { PointerEvent as RPE } from 'react';
import type { NodeType } from './engine';
import { CATALOG } from './nodes';

/**
 * Left rail: draggable component chips. The chip captures the pointer on
 * pointerdown (see Studio.onChipPointerDown), so move/up/cancel all route back
 * through these handlers even while the cursor is over the canvas.
 */
export function Palette({
  onChipPointerDown,
  onChipPointerMove,
  onChipPointerUp,
  onChipPointerCancel,
}: {
  onChipPointerDown: (type: NodeType, e: RPE) => void;
  onChipPointerMove: (e: RPE) => void;
  onChipPointerUp: (e: RPE) => void;
  onChipPointerCancel: () => void;
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
          onPointerMove={onChipPointerMove}
          onPointerUp={onChipPointerUp}
          onPointerCancel={onChipPointerCancel}
          aria-label={`Add ${c.label}`}
        >
          <span className="chip-label">{c.label}</span>
          <span className="chip-blurb">{c.blurb}</span>
        </button>
      ))}
    </div>
  );
}
