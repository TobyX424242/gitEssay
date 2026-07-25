/**
 * gitEssay — conversation switcher (extracted from ChatSidebar).
 *
 * The dropdown above the message list: shows the active conversation's title,
 * opens a menu to switch/delete conversations, and a "+ New" button to start a
 * fresh one.
 */
import {type JSX, useState} from 'react';

import {
  createConversation,
  deleteConversation,
  setActiveConversation,
  useConversations,
} from './conversations';

export default function ConversationSwitcher(): JSX.Element {
  const {conversations, activeId, active} = useConversations();
  const [showList, setShowList] = useState(false);

  return (
    <div className="chat-switcher">
      <button
        type="button"
        className="chat-switcher-btn"
        onClick={() => setShowList(v => !v)}
        title="Switch conversation"
        aria-label="Switch conversation">
        <span className="chat-switcher-title">
          {active?.title || 'Conversations'}
        </span>
        <span className="chat-switcher-chev">▾</span>
      </button>
      <button
        type="button"
        className="chat-switcher-new"
        onClick={() => {
          void createConversation();
          setShowList(false);
        }}
        title="New conversation"
        aria-label="New conversation">
        + New
      </button>
      {showList && (
        <>
          <div
            className="chat-switcher-backdrop"
            onClick={() => setShowList(false)}
          />
          <div className="chat-switcher-list" role="menu">
            {conversations.length === 0 && (
              <div className="chat-switcher-empty">No conversations.</div>
            )}
            {conversations.map(c => (
              <div
                key={c.id}
                role="menuitem"
                className={`chat-conv-item${c.id === activeId ? ' is-active' : ''}`}
                onClick={() => {
                  void setActiveConversation(c.id);
                  setShowList(false);
                }}>
                <span className="chat-conv-title">{c.title || 'Untitled'}</span>
                <button
                  type="button"
                  className="chat-conv-del"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                  onClick={e => {
                    e.stopPropagation();
                    void deleteConversation(c.id);
                  }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
