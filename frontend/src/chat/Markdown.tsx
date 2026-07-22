/**
 * gitEssay — markdown renderer for AI reply text.
 *
 * The assistant's prose is very often markdown (headings, **bold**, lists, code,
 * links, tables). react-markdown renders it to React elements and does NOT allow
 * raw HTML by default, so AI output can't inject markup (safe). remark-gfm adds
 * tables, strikethrough, task lists, and autolinks.
 *
 * Math: the agent reads/writes LaTeX equations, so its replies tend to quote
 * LaTeX — remark-math + rehype-katex render $…$ / $$…$$ inline into human-
 * readable formulas instead of raw source (KaTeX CSS is loaded app-wide by
 * EquationsExtension; rendering is throwOnError:false, so bad LaTeX degrades
 * to red source text rather than breaking the message).
 *
 * Memoized: finalized messages keep the same `text` and skip re-parsing; only
 * the live-streaming bubble re-parses as tokens arrive (cheap for chat lengths).
 */
import {type JSX, memo} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

function MarkdownBase({children}: {children: string}): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownBase);
export default Markdown;
