import { LRUCache } from 'lru-cache';
import { canUseCanonicalCacheAlias, isHtmlLikeContentType } from './network';
import type { FetchResult } from './types';

export function calculateCacheSize(value: FetchResult): number {
  if ('binary' in value) return value.data?.byteLength ?? 1024;
  // llms.txt and plain-text pages point all four fields at the same
  // content, so charge bytes once per distinct string value.
  const refs = [value.rawContent, value.html, value.markdown, value.text];
  const seen = new Set<string>();
  let total = 0;
  for (const ref of refs) {
    if (typeof ref !== 'string' || seen.has(ref)) continue;
    seen.add(ref);
    total += Buffer.byteLength(ref);
  }
  return total;
}

export const CACHE = new LRUCache<string, FetchResult>({
  maxSize: 50 * 1024 * 1024,
  ttl: 15 * 60 * 1000,
  sizeCalculation: calculateCacheSize,
});

export function buildCacheKey(
  url: string,
  extractMain: boolean,
  preferLlmsTxt: 'auto' | 'always' | 'never',
  saveBinary: boolean,
) {
  const parsed = new URL(url);
  // Fragments never reach the server (RFC 3986 §3.5); #sec1 and #sec2 are
  // the same document, so they must share one cache entry.
  parsed.hash = '';
  return JSON.stringify({
    url: parsed.toString(),
    extractMain,
    preferLlmsTxt,
    saveBinary,
  });
}

function cacheKeysFor(
  fetchResult: FetchResult,
  extractMain: boolean,
  preferLlmsTxt: 'auto' | 'always' | 'never',
  saveBinary: boolean,
) {
  const keys = new Set<string>();
  keys.add(
    buildCacheKey(
      fetchResult.requestedUrl,
      extractMain,
      preferLlmsTxt,
      saveBinary,
    ),
  );
  keys.add(
    buildCacheKey(fetchResult.finalUrl, extractMain, preferLlmsTxt, saveBinary),
  );
  if (
    fetchResult.canonicalUrl &&
    canUseCanonicalCacheAlias(fetchResult.finalUrl, fetchResult.canonicalUrl)
  ) {
    keys.add(
      buildCacheKey(
        fetchResult.canonicalUrl,
        extractMain,
        preferLlmsTxt,
        saveBinary,
      ),
    );
  }
  return [...keys];
}

export function cacheFetchResult(
  fetchResult: FetchResult,
  extractMain: boolean,
  preferLlmsTxt: 'auto' | 'always' | 'never',
  saveBinary: boolean,
) {
  for (const key of cacheKeysFor(
    fetchResult,
    extractMain,
    preferLlmsTxt,
    saveBinary,
  )) {
    CACHE.set(key, fetchResult);
  }
}

export function isInvalidLlmsResult(fetchResult: FetchResult | undefined) {
  if (!fetchResult || 'binary' in fetchResult) return false;
  if (!fetchResult.usedLlmsTxt || fetchResult.sourceKind !== 'llms_txt') {
    return false;
  }
  const finalPath = (() => {
    try {
      return new URL(fetchResult.finalUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (
    !(finalPath.endsWith('/llms.txt') || finalPath.endsWith('/llms-full.txt'))
  ) {
    return true;
  }
  if (isHtmlLikeContentType(fetchResult.contentType)) return true;
  if (/^\s*(<!doctype html|<html\b)/i.test(fetchResult.rawContent)) return true;
  if (
    /<title>\s*(log in|sign in|login)\b/i.test(fetchResult.rawContent) ||
    /\blog[ -]?in\b/i.test(fetchResult.finalUrl)
  ) {
    return true;
  }
  return false;
}
