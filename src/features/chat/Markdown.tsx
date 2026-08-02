import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { rehypeDialogue } from './dialogue.ts';

const PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeDialogue];

/**
 * Rendered message text.
 *
 * Memoised on the string: a transcript of fifty messages would otherwise re-parse every
 * one of them whenever anything in the chat changed.
 */
export const Markdown = memo(function Markdown({
  text,
  className = 'message__text',
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
