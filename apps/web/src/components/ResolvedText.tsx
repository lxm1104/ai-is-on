import { Fragment, useEffect, useState } from 'react';
import {
  extractSegments,
  getCachedDoc,
  getCachedUser,
  resolveDocUrl,
  resolveOpenId,
  type FeishuRef,
} from '../lib/resolveNames';

/**
 * Render a text blob that may embed Feishu doc URLs or `ou_xxx` open_ids,
 * swapping them inline with resolved doc titles / user display names.
 *
 * Falls back gracefully:
 * - while resolving: shows the original label (already rendered, no flash)
 * - on resolve failure or unknown: keeps the original label/raw token
 */
export function ResolvedText(props: { text: string | null | undefined; inline?: boolean }) {
  const text = props.text ?? '';
  // Re-render trigger when async resolutions land in the cache.
  const [, setTick] = useState(0);

  const segments = extractSegments(text);

  useEffect(() => {
    let cancelled = false;
    const pending: Promise<unknown>[] = [];
    for (const seg of segments) {
      if (seg.type !== 'ref') continue;
      const ref = seg.ref;
      if (ref.kind === 'mdlink' || ref.kind === 'url') {
        if (getCachedDoc(ref.url) === undefined) {
          pending.push(resolveDocUrl(ref.url));
        }
      } else if (ref.kind === 'openid') {
        if (getCachedUser(ref.openId) === undefined) {
          pending.push(resolveOpenId(ref.openId));
        }
      }
    }
    if (pending.length === 0) return;
    Promise.allSettled(pending).then(() => {
      if (!cancelled) setTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
    // segments is rebuilt each render; key the effect by the raw text instead
    // so we don't re-trigger on every render of the parent component.
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!text) return null;
  if (segments.length === 0 || segments.every((s) => s.type === 'text')) {
    return <>{text}</>;
  }

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === 'text') return <Fragment key={idx}>{seg.text}</Fragment>;
        return <RefView key={idx} item={seg.ref} />;
      })}
    </>
  );
}

// NOTE: do NOT name this prop `ref` — React treats `ref` as a reserved prop on
// function components and strips it, leaving the child receiving `undefined`,
// which would crash the whole tree to a blank page.
function RefView({ item }: { item: FeishuRef }) {
  if (item.kind === 'openid') {
    const name = getCachedUser(item.openId);
    const label = name ? `@${name}` : item.raw;
    return <span className="resolved-user">{label}</span>;
  }
  // doc link / bare URL
  const doc = getCachedDoc(item.url);
  const fallback = item.kind === 'mdlink' ? item.label : item.url;
  // If the markdown link label is just the raw token, prefer the resolved title.
  const looksLikeToken =
    item.kind === 'mdlink' && /^[A-Za-z0-9_-]{10,}$/.test(item.label);
  let display: string;
  if (doc && doc.title) {
    display = doc.title;
  } else if (looksLikeToken) {
    display = item.kind === 'mdlink' ? '飞书文档' : '飞书链接';
  } else {
    display = fallback;
  }
  return (
    <a
      className="resolved-doc"
      href={item.url}
      target="_blank"
      rel="noreferrer"
      title={doc?.title ?? item.url}
    >
      {display}
    </a>
  );
}
