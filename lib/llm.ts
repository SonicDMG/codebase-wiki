/**
 * llm.ts
 *
 * Thin OpenAI-SDK wrapper pointed at an OpenAI-compatible proxy (LiteLLM,
 * OpenRouter, Ollama). Provider and model are swapped purely through env:
 *   LLM_BASE_URL  — proxy base URL
 *   LLM_API_KEY   — API key for the proxy ("ollama" for a local Ollama)
 *   LLM_MODEL     — model identifier; REQUIRED, there is no default
 *   LLM_JSON_MODE — auto | on | off; "off" disables response_format entirely
 *   JEV_MODEL     — optional; model for fast topic classification
 *
 * The client carries explicit timeouts and NO SDK-level retries: the SDK
 * default is a ten-minute request timeout with two retries, which can hold a
 * request open for half an hour. Worst case here is a single 60 s call.
 */

import OpenAI from 'openai';

let client: OpenAI | null = null;

/** Singleton LLM client. Throws when LLM_API_KEY is missing. */
export function llmClient(): OpenAI {
  if (client) return client;

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('Missing LLM_API_KEY env var — set LLM_API_KEY (use "ollama" for a local Ollama)');
  }

  const baseURL = process.env.LLM_BASE_URL;

  client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout: 60_000,
    maxRetries: 0,
  });

  return client;
}

/**
 * The configured model. Deliberately has no default: a silently wrong default
 * model produces a 404 from the proxy that reads like a network failure.
 */
export function getLlmModel(): string {
  const model = process.env.LLM_MODEL;
  if (!model) {
    throw new Error('Missing LLM_MODEL env var — set the exact model id your LLM_BASE_URL serves');
  }
  return model;
}

/** The model identifier to use for JEV decisions. Defaults to `~typesafe/jev-latest`. */
export function getJevModel(): string {
  return process.env.JEV_MODEL?.trim() || '~typesafe/jev-latest';
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

/** Whether to attempt response_format: json_object. Several proxies reject it. */
export function supportsJsonMode(): boolean {
  return process.env.LLM_JSON_MODE !== 'off';
}
