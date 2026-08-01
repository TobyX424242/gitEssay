/**
 * gitEssay — backdrop click-to-dismiss for modal overlays.
 *
 * Closes only when BOTH the press (mousedown) and the release (click) land on
 * the backdrop itself. Pressing inside the panel and dragging/releasing past
 * its edge (e.g. while selecting text in an input) must NOT close the dialog —
 * with a plain `onClick={onClose}` on the overlay that stray click would hit
 * the overlay as the common ancestor and discard the user's edits.
 */
import {type MouseEvent, useRef} from 'react';

export default function useOverlayDismiss(onDismiss: () => void): {
  onMouseDown: (e: MouseEvent<HTMLDivElement>) => void;
  onClick: (e: MouseEvent<HTMLDivElement>) => void;
} {
  const pressedOnOverlay = useRef(false);

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    pressedOnOverlay.current = e.target === e.currentTarget;
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (pressedOnOverlay.current && e.target === e.currentTarget) {
      onDismiss();
    }
    pressedOnOverlay.current = false;
  };

  return {onMouseDown, onClick};
}
