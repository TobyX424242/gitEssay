/**
 * gitEssay — global drag-and-drop upload for literature.
 *
 * Drag a PDF/DOCX anywhere over the app → a full-screen drop overlay appears;
 * dropping uploads the file(s) to the active project and opens the Literature
 * tab. Only activates for drags that look like PDF/DOCX (by MIME), so image
 * drops into the editor keep working untouched. Files are filtered by
 * extension on drop.
 */
import {type JSX, useEffect, useRef, useState} from 'react';

import {openLeftDock} from '../chat/panelStore';
import {useActiveProjectId} from '../projects/projectStore';
import {trackUpload} from './literature';

const LIT_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function hasLiteratureFile(e: DragEvent): boolean {
  const items = Array.from(e.dataTransfer?.items ?? []);
  return items.some(
    it => it.kind === 'file' && (LIT_MIMES.has(it.type) || it.type === ''),
  );
}

export default function LiteratureDropZone(): JSX.Element | null {
  const pid = useActiveProjectId();
  const [active, setActive] = useState(false);
  // Nested dragenter/leave pairs (child elements) — track depth, not booleans.
  const depth = useRef(0);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!hasLiteratureFile(e)) {
        return;
      }
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasLiteratureFile(e)) {
        e.preventDefault(); // required to allow a drop
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasLiteratureFile(e)) {
        return;
      }
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        setActive(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!hasLiteratureFile(e)) {
        return;
      }
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter(f =>
        /\.(pdf|docx)$/i.test(f.name),
      );
      if (pid && files.length > 0) {
        openLeftDock('literature');
        for (const f of files) {
          trackUpload(pid, f);
        }
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [pid]);

  if (!active) {
    return null;
  }
  return (
    <div className="lit-global-drop" role="presentation">
      <div className="lit-global-drop-card">📚 Drop PDF / DOCX to add to the literature library</div>
    </div>
  );
}
