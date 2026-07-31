import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm, remarkBreaks];

/**
 * Rendered message text.
 *
 * Memoised on the string: a transcript of fifty messages would otherwise re-parse every
 * one of them whenever anything in the chat changed.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="message__text">
      <ReactMarkdown remarkPlugins={PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
});
