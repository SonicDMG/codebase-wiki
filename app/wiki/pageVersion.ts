/**
 * pageVersion.ts — detects when the topic's stored page differs from the
 * page shown in the reader's conversation. Structural types only, so this
 * file doesn't import from page.tsx.
 */

interface MessageLike {
  id: string;
  answers?: Partial<Record<'wiki' | 'picture', { content: string; pending?: boolean }>>;
}

interface TopicLike {
  slug: string;
  generatedPage?: string;
  generatedPagePicture?: string;
  pageCommitSha?: string;
  updatedAt?: string;
}

/** Identifies one version of a topic's page (for dismissal). */
export function topicVersion(topic: TopicLike): string {
  return topic.updatedAt ?? `${topic.pageCommitSha ?? ''}:${(topic.generatedPage ?? '').length}`;
}

/** True when the topic now has a page for `mode` that differs from the one shown. */
export function newerPageAvailable(
  messages: MessageLike[],
  topic: TopicLike,
  mode: 'wiki' | 'picture',
): boolean {
  const latest = mode === 'picture' ? topic.generatedPagePicture : topic.generatedPage;
  if (!latest) return false;
  const shown = messages.find((m) => m.id === `page-${topic.slug}`)?.answers?.[mode];
  if (!shown || shown.pending) return false;
  return shown.content.trim() !== latest.trim();
}
