/**
 * gitEssay — shared resize handle for a side-panel dock.
 *
 * `dockSide='right'` (the AI chat dock on the right of the viewport): the handle
 * sits on the dock's LEFT edge; dragging it left widens the dock.
 * `dockSide='left'` (the Versions dock on the left): the handle sits on the
 * dock's RIGHT edge; dragging it right widens the dock.
 *
 * During the drag it calls store.setDragWidth (which can reach the collapse
 * zone). On release: if the width is at/below collapseAt the dock closes (and
 * resets to its default width so reopening looks right), otherwise it snaps to
 * the persisted [minWidth, maxWidth] range.
 */
import {type JSX, type PointerEvent as ReactPointerEvent} from 'react';

import type {SidePanelStore} from './sidePanelStore';

export function SidePanelResizer({
  store,
  dockSide,
}: {
  store: SidePanelStore;
  dockSide: 'left' | 'right';
}): JSX.Element {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = store.getState().width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const w =
        dockSide === 'right'
          ? startWidth + (startX - ev.clientX)
          : startWidth + (ev.clientX - startX);
      store.setDragWidth(w);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const w = store.getState().width;
      if (store.shouldCollapse(w)) {
        store.close();
        store.setWidth(store.defaultWidth);
      } else {
        store.setWidth(store.clampWidth(w));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`side-resizer side-resizer--${dockSide}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${dockSide === 'right' ? 'AI' : 'versions'} panel`}
    />
  );
}
