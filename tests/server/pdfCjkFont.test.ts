import assert from 'node:assert/strict';
import { assertUsableTrueType, wrapMixedText } from '../../src/services/pdfCjkFont.ts';

// 1 unit per Latin char, 2 per CJK char (rough em model)
const measure = (s: string) => [...s].reduce((w, c) => w + (/[\u2e80-\ua4cf\uff00-\uffef]/.test(c) ? 2 : 1), 0);

{
  const text = '马来西亚政治格局和国家政治走向的深入分析';
  const lines = wrapMixedText(text, 10, measure);
  assert.ok(lines.length > 1, 'unbroken CJK text must wrap');
  assert.ok(lines.every((l) => measure(l) <= 10), 'no line exceeds max width');
  assert.equal(lines.join(''), text, 'no characters lost');
}
{
  const lines = wrapMixedText('政府治理改革，公共服务提升。', 12, measure);
  assert.ok(lines.every((l) => !/^[，。、]/.test(l)), 'punctuation must not start a line');
}
{
  const lines = wrapMixedText('Madani 政府 reform agenda', 14, measure);
  assert.ok(lines.some((l) => l.includes('Madani')), 'Latin words stay intact');
}
{
  assert.deepEqual(wrapMixedText('', 10, measure), ['']);
  assert.equal(wrapMixedText('a\nb', 10, measure).length, 2);
}
{
  assert.throws(() => assertUsableTrueType(new TextEncoder().encode('<!doctype html>'.padEnd(2000, ' '))));
  const ttf = new Uint8Array(2000); ttf.set([0, 1, 0, 0]);
  assert.doesNotThrow(() => assertUsableTrueType(ttf));
  const otf = new Uint8Array(2000); otf.set([0x4f, 0x54, 0x54, 0x4f]);
  assert.throws(() => assertUsableTrueType(otf));
}
console.log('pdfCjkFont regression checks passed');
