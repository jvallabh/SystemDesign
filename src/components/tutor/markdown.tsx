import { createElement } from 'react';
import type { ReactNode } from 'react';
import { withBase } from '../../utils/url';
import { CITATION_RE } from './prompts';

// Inline tokens, in priority order: `code`, **bold**, [[citation]]. The citation
// alternative reuses CITATION_RE (the single source of truth) — its own capture
// group becomes group 4 (the id); group 3 is the whole `[[…]]` match.
const INLINE_RE = new RegExp(
  `\`([^\`]+)\`|\\*\\*([^*]+)\\*\\*|(${CITATION_RE.source})`,
  'g',
);

/** Look up a topic title by id; returns undefined for ids not in the corpus. */
export type TitleFor = (id: string) => string | undefined;

function renderInline(text: string, titleFor: TitleFor, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  // exec-based walk; INLINE_RE is stateful so reset lastIndex per call.
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[1] !== undefined) {
      nodes.push(<code key={key}>{m[1]}</code>);
    } else if (m[2] !== undefined) {
      nodes.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      const id = m[4];
      const title = titleFor(id);
      if (title !== undefined) {
        nodes.push(
          <a key={key} className="tutor-cite" href={withBase(`/topics/${id}/`)}>
            {title}
          </a>,
        );
      } else {
        // Invalid / unknown id degrades to plain text.
        nodes.push(`[[${id}]]`);
      }
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Hand-rolled mini markdown renderer (no markdown library). Supports
 * paragraphs, **bold**, `inline code`, fenced code blocks, `-`/`*` lists,
 * `#`-style headings, and [[id]] citation chips. Pure: same input → same tree.
 */
export function renderMarkdown(text: string, titleFor: TitleFor): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence
      blocks.push(
        <pre key={key++}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // ATX heading — shift down two levels so chat headings stay small (## → h4).
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(
        createElement(
          `h${level}`,
          { key: key++ },
          renderInline(heading[2], titleFor, `h${key}`),
        ),
      );
      i++;
      continue;
    }

    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item, titleFor, `li${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Blank line.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line or a block start.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(para.join(' '), titleFor, `p${key}`)}</p>);
  }

  return <>{blocks}</>;
}
