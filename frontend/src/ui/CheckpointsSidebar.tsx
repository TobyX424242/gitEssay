/**
 * gitEssay — left Versions dock (checkpoints), mirroring the AI chat dock.
 * Collapsible + resizable; holds the checkpoint list so it is always reachable
 * regardless of document length. It stays open during compare mode; the
 * "Exit compare" button lives inside the list next to the Compare button.
 * Toggled from the app bar or its left-edge tab.
 */
import {type JSX, useEffect} from 'react';

import {versionsPanel} from '../chat/panelStore';
import CheckpointsList from './CheckpointsList';
import {SidePanelResizer} from './SidePanelResizer';
import {useScrollTrap} from './useScrollTrap';
import {useSidePanel} from './sidePanelStore';

export default function CheckpointsSidebar(): JSX.Element {
  const {open, width} = useSidePanel(versionsPanel);
  const trapRef = useScrollTrap();

  useEffect(() => {
    document.body.style.setProperty('--ge-versions-width', `${width}px`);
    if (open) {
      document.body.classList.add('ge-versions-open');
    } else {
      document.body.classList.remove('ge-versions-open');
    }
    return () => document.body.classList.remove('ge-versions-open');
  }, [open, width]);

  return (
    <>
      {!open && (
        <button
          type="button"
          className="side-reopen side-reopen--left"
          onClick={() => versionsPanel.open()}
          title="Open version history"
          aria-label="Open version history">
          Versions ›
        </button>
      )}
      <aside
        ref={trapRef}
        className={`versions-dock${open ? ' is-open' : ''}`}
        aria-hidden={!open}>
        <SidePanelResizer store={versionsPanel} dockSide="left" />
        <header className="dock-header">
          <span className="dock-title">Versions</span>
          <button
            type="button"
            className="cp-close"
            onClick={() => versionsPanel.close()}
            title="Collapse"
            aria-label="Collapse versions">
            ‹
          </button>
        </header>
        <div className="dock-body">
          <CheckpointsList />
        </div>
      </aside>
    </>
  );
}
