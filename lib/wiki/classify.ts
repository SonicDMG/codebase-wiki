/**
 * classify.ts — JEV single-file classification for the wiki topic system.
 *
 * Calls the OpenRouter Decisions API (JEV) to classify one file path into an
 * existing topic (or "none"). On any failure (network, missing key, bad
 * response) returns null so the path is queued in unclassifiedPaths; this
 * function never throws upwards into syncBranch.
 */

import { getJevModel } from '@/lib/llm';
import type { WikiTopicDoc } from './types';

/**
 * Classify a single file path into one of the given topics using JEV.
 *
 * @param filePath   The path to classify (e.g. "packages/api/lib/wiki/sync.ts").
 * @param siblings   Up to ~10 sibling paths (same directory) for context.
 * @param topics     The current set of topics. Choices include each topic's slug
 *                   plus the special slug "none".
 * @returns          The matching topic slug, or null (→ "none") on error/refusal.
 */
export async function classifyFile(
  filePath: string,
  siblings: string[],
  topics: WikiTopicDoc[],
): Promise<string | null> {
  if (topics.length === 0) return null;

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;

  const baseURL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
  const decisionsURL = baseURL.replace(/\/v1\/?$/, '/alpha/decisions');
  const model = getJevModel();

  // Build the choice map: slug → "title: description"
  const choices: Record<string, string> = { none: 'none: This file does not clearly belong to any existing topic' };
  for (const t of topics) {
    choices[t.slug] = `${t.title}: ${t.description}`;
  }

  // State: path + sibling context
  const siblingContext = siblings.filter((s) => s !== filePath).slice(0, 10);
  const state = [
    `File to classify: ${filePath}`,
    siblingContext.length > 0 ? `Sibling paths in same directory:\n${siblingContext.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await fetch(decisionsURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/SonicDMG/walfly',
        'X-OpenRouter-Title': 'Codebase Wiki Classification',
      },
      body: JSON.stringify({
        model,
        state,
        questions: {
          topic: {
            type: 'choice',
            instructions:
              'Which existing wiki topic does this file most naturally belong to? Choose "none" only when the file is clearly unrelated to all existing topics.',
            criteria: choices,
          },
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[wiki/classify] JEV returned status ${res.status} for "${filePath}"`);
      return null;
    }

    const json = await res.json();
    const answer = json?.answers?.topic;
    if (answer?.type === 'choice' && typeof answer.choice === 'string') {
      const chosen = answer.choice.trim();
      if (chosen === 'none') return null;
      // Validate the returned slug actually exists.
      if (topics.some((t) => t.slug === chosen)) return chosen;
      console.warn(`[wiki/classify] JEV returned unknown slug "${chosen}" for "${filePath}"`);
      return null;
    }
    return null;
  } catch (err) {
    console.warn(`[wiki/classify] JEV request failed for "${filePath}":`, err);
    return null;
  }
}
