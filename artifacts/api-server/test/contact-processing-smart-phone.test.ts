import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePhone, isInternationalPhoneValue } from '../src/services/contact-processing';

const cases: Array<[string, string | undefined, string]> = [
  ['+918400973452', undefined, '+918400973452'],
  ['918400973452', '91', '+918400973452'],
  ['918400973452', undefined, '+918400973452'],
  ['8400973452', '91', '+918400973452'],
  ['+917355014296', '91', '+917355014296'],
  ['5511987654321', '55', '+5511987654321'],
  ['5511987654321', undefined, '+5511987654321'],
  ['5511987654321', '91', '+5511987654321'],
  ['11987654321', '55', '+5511987654321'],
  ['+5511987654321', '91', '+5511987654321'],
  ['525512345678', undefined, '+525512345678'],
  ['5512345678', '52', '+525512345678'],
];

for (const [raw, country, expected] of cases) {
  test(`normalizes ${raw} with fallback ${country ?? 'auto'}`, () => {
    assert.equal(normalizePhone(raw, country).value, expected);
  });
}

test('rejects double country prefixes rather than sending malformed E.164', () => {
  assert.equal(normalizePhone('91918400973452', '91').value, undefined);
  assert.equal(normalizePhone('+91918400973452').value, undefined);
});

test('rejects unsupported national numbers without country fallback', () => {
  assert.equal(normalizePhone('8400973452').value, undefined);
});

test('recognizes bare international numbers during sniff', () => {
  assert.equal(isInternationalPhoneValue('918400973452'), true);
  assert.equal(isInternationalPhoneValue('5511987654321'), true);
  assert.equal(isInternationalPhoneValue('8400973452'), false);
});
