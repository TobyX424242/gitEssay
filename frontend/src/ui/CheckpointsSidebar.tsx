/**
 * gitEssay — left dock, tabbed between "Versions" (checkpoint history) and
 * "Literature" (the uploaded reference library). Collapsible + resizable; the
 * dock stays open during compare mode. Toggled from the app bar or its
 * left-edge tab.
 */
import {type JSX, useEffect} from 'react';

import {
  openLeftDock,
  setLeftDockTab,
  useLeftDockTab,
  versionsPanel,
} from '../chat/panelStore';
import CheckpointsList from './CheckpointsList';
import LiteraturePanel from './LiteraturePanel';
import {SidePanelResizer} from './SidePanelResizer';
import {useScrollTrap} from './useScrollTrap';
import {useSidePanel} from './sidePanelStore';

export default function CheckpointsSidebar(): JSX.Element {
  const {open, width} = useSidePanel(versionsPanel);
  const trapRef = useScrollTrap();
  const tab = useLeftDockTab();

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
        <div className="side-reopen-stack side-reopen-stack--left">
          <button
            type="button"
            className="side-reopen side-reopen--left"
            onClick={() => openLeftDock('versions')}
            title="Open version history"
            aria-label="Open version history">
            Versions ›
          </button>
          <button
            type="button"
            className="side-reopen side-reopen--left"
            onClick={() => openLeftDock('literature')}
            title="Open literature library"
            aria-label="Open literature library">
            Literature ›
          </button>
        </div>
      )}
      <aside
        ref={trapRef}
        className={`versions-dock${open ? ' is-open' : ''}`}
        aria-hidden={!open}>
        <SidePanelResizer store={versionsPanel} dockSide="left" />
        <header className="dock-header">
          <div className="dock-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'versions'}
              className={`dock-tab${tab === 'versions' ? ' is-active' : ''}`}
              onClick={() => setLeftDockTab('versions')}>
              Versions
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'literature'}
              className={`dock-tab${tab === 'literature' ? ' is-active' : ''}`}
              onClick={() => setLeftDockTab('literature')}>
              Literature
            </button>
          </div>
          <button
            type="button"
            className="cp-close"
            onClick={() => versionsPanel.close()}
            title="Collapse"
            aria-label="Collapse panel">
            ‹
          </button>
        </header>
        <div className="dock-body">
          {tab === 'versions' ? <CheckpointsList /> : <LiteraturePanel />}
        </div>
      </aside>
    </>
  );
}
