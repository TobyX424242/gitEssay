/**
 * gitEssay — markdown renderer for AI reply text.
 *
 * The assistant's prose is very often markdown (headings, **bold**, lists, code,
 * links, tables). react-markdown renders it to React elements and does NOT allow
 * raw HTML by default, so AI output can't inject markup (safe). remark-gfm adds
 * tables, strikethrough, task lists, and autolinks.
 *
 * Memoized: finalized messages keep the same `text` and skip re-parsing; only
 * the live-streaming bubble re-parses as tokens arrive (cheap for chat lengths).
 */
import {type JSX, memo} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function MarkdownBase({children}: {children: string}): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownBase);
export default Markdown;
