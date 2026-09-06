import { describe, expect, test } from 'bun:test';
import { LRUCache } from 'lru-cache';
import { buildCacheKey, calculateCacheSize } from './cache';
import type { BinaryFetch, CachedFetch, FetchResult } from './types';

describe('smartfetch/cache', () => {
  test('includes save_binary but not format in the cache key', () => {
    const markdownKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      false,
    );
    const htmlKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      false,
    );
    const binaryKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      true,
    );

    expect(markdownKey).toBe(htmlKey);
    expect(markdownKey).not.toBe(binaryKey);
    expect(JSON.parse(markdownKey)).toMatchObject({
      saveBinary: false,
    });
    expect(JSON.parse(binaryKey)).toMatchObject({
      saveBinary: true,
    });
  });

  test('URL fragments are not part of the cache key (RFC 3986)', () => {
    const noFragment = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      false,
    );
    const sec1 = buildCacheKey(
      'https://example.com/docs#sec1',
      true,
      'auto',
      false,
    );
    const sec2 = buildCacheKey(
      'https://example.com/docs#sec2',
      true,
      'auto',
      false,
    );
    const emptyFragment = buildCacheKey(
      'https://example.com/docs#',
      true,
      'auto',
      false,
    );

    expect(sec1).toBe(noFragment);
    expect(sec2).toBe(noFragment);
    expect(emptyFragment).toBe(noFragment);
  });

  test('query strings still distinguish cache keys', () => {
    const page1 = buildCacheKey(
      'https://example.com/docs?page=1#x',
      true,
      'auto',
      false,
    );
    const page2 = buildCacheKey(
      'https://example.com/docs?page=2#x',
      true,
      'auto',
      false,
    );

    expect(page1).not.toBe(page2);
  });

  test('option changes still produce distinct cache keys', () => {
    const base = buildCacheKey(
      'https://example.com/docs#sec1',
      true,
      'auto',
      false,
    );
    const noExtract = buildCacheKey(
      'https://example.com/docs#sec1',
      false,
      'auto',
      false,
    );
    const alwaysLlms = buildCacheKey(
      'https://example.com/docs#sec1',
      true,
      'always',
      false,
    );
    const saveBinary = buildCacheKey(
      'https://example.com/docs#sec1',
      true,
      'auto',
      true,
    );

    expect(noExtract).not.toBe(base);
    expect(alwaysLlms).not.toBe(base);
    expect(saveBinary).not.toBe(base);
  });

  test('llms.txt-shaped result is charged once for its content', () => {
    const llmsTxt = Array.from(
      { length: 64 },
      (_, i) => `# Section ${i}\nhttps://example.com/doc-${i}`,
    ).join('\n');
    const result = makeCached({
      rawContent: llmsTxt,
      html: llmsTxt,
      markdown: llmsTxt,
      text: llmsTxt,
    });

    expect(calculateCacheSize(result)).toBe(Buffer.byteLength(llmsTxt));
  });

  test('text-page result with equal content in distinct references is charged once', () => {
    const content = 'plain text line'.repeat(512);
    const result = makeCached({
      rawContent: content,
      html: content.slice(0),
      markdown: `\n${content}\n`.trim(),
      text: ` ${content} `.slice(1, -1),
    });

    expect(calculateCacheSize(result)).toBe(Buffer.byteLength(content));
  });

  test('html result with four distinct fields is charged for all four', () => {
    const rawContent = 'raw html source'.repeat(50);
    const html = '<html><body>markup</body></html>'.repeat(50);
    const markdown = '# heading\ntext'.repeat(50);
    const text = 'plain extract'.repeat(50);
    const result = makeCached({ rawContent, html, markdown, text });

    expect(calculateCacheSize(result)).toBe(
      Buffer.byteLength(rawContent) +
        Buffer.byteLength(html) +
        Buffer.byteLength(markdown) +
        Buffer.byteLength(text),
    );
  });

  test('binary result is charged for its data byteLength', () => {
    const data = new Uint8Array(4096);
    expect(calculateCacheSize(makeBinary(data))).toBe(4096);
  });

  test('binary result without data falls back to 1024 bytes', () => {
    expect(calculateCacheSize(makeBinary())).toBe(1024);
  });

  test('real LRUCache holds ~4x more plain-text entries with deduped accounting', () => {
    const maxSize = 20 * 1024 * 1024;
    const entryBytes = 128 * 1024;
    const content = 'x'.repeat(entryBytes);
    const entry = makeCached({
      rawContent: content,
      html: content,
      markdown: content,
      text: content,
    });

    const deduped = new LRUCache<string, FetchResult>({
      maxSize,
      sizeCalculation: calculateCacheSize,
    });
    const naive = new LRUCache<string, FetchResult>({
      maxSize,
      sizeCalculation: (value: FetchResult) => {
        const cached = value as CachedFetch;
        return (
          Buffer.byteLength(cached.rawContent) +
          Buffer.byteLength(cached.html) +
          Buffer.byteLength(cached.markdown) +
          Buffer.byteLength(cached.text)
        );
      },
    });

    for (let i = 0; i < 500; i++) {
      const key = `https://example.com/doc-${i}`;
      deduped.set(key, entry);
      naive.set(key, entry);
    }

    // 20MiB / 128KiB = 160 entries; allow a small implementation margin.
    expect(deduped.size).toBeGreaterThanOrEqual(150);
    expect(deduped.size).toBeLessThanOrEqual(161);
    // Old accounting charges 4x per entry: 20MiB / 512KiB = 40.
    expect(naive.size).toBeLessThanOrEqual(50);
    expect(deduped.size).toBeGreaterThan(naive.size * 3);
  });
});

function makeCached(overrides: Partial<CachedFetch>): CachedFetch {
  return {
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    statusCode: 200,
    contentType: 'text/plain',
    rawContent: '',
    markdown: '',
    text: '',
    html: '',
    extractedMain: false,
    usedLlmsTxt: false,
    sourceKind: 'text',
    upgradedToHttps: false,
    redirectChain: [],
    truncated: false,
    wordCount: 0,
    ...overrides,
  };
}

function makeBinary(data?: Uint8Array): BinaryFetch {
  return {
    requestedUrl: 'https://example.com/file',
    finalUrl: 'https://example.com/file',
    statusCode: 200,
    contentType: 'application/pdf',
    redirectChain: [],
    upgradedToHttps: false,
    truncated: false,
    binary: true,
    binaryKind: 'pdf',
    data,
  };
}
