/**
 * gitEssay — global error boundary. Without it, any render crash (e.g. a
 * failed lazy-chunk load after a deploy) unmounts the whole tree and leaves a
 * blank page with no way back. This shows a minimal recoverable error screen
 * instead; the document itself is safe server-side (checkpoints), so a reload
 * is always a valid recovery.
 */
import * as React from 'react';

type Props = {children: React.ReactNode};
type State = {error: Error | null};

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the stack in the console for debugging; the UI stays minimal.
    console.error('gitEssay crashed:', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          height: '100vh',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
        }}>
        <h2 style={{margin: 0}}>Something went wrong</h2>
        <p style={{color: '#777', margin: 0, maxWidth: 480}}>
          {this.state.error.message}
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{cursor: 'pointer', padding: '8px 20px'}}>
          Reload
        </button>
      </div>
    );
  }
}
