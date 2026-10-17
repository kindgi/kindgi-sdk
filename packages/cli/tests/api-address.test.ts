// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { isLocalAddress, sameAddress } from '../src/api-address.js';

describe('sameAddress: one address, however it is written', () => {
  test.each([
    ['https://platform.example.com', 'https://PLATFORM.Example.com'],
    ['https://platform.example.com', 'https://platform.example.com:443'],
    ['http://platform.example.com', 'http://platform.example.com:80'],
    ['https://platform.example.com', 'https://platform.example.com/'],
    ['https://platform.example.com/api', 'https://platform.example.com/api/'],
    ['http://127.0.0.1:4000', 'http://localhost:4000'],
    ['http://[::1]:4000/', 'http://127.0.0.1:4000'],
  ])('%s is %s', (a, b) => {
    expect(sameAddress(a, b)).toBe(true);
    expect(sameAddress(b, a)).toBe(true);
  });

  test.each([
    ['https://platform.example.com', 'http://platform.example.com'],
    ['https://platform.example.com', 'https://platform.example.com:8443'],
    ['http://localhost:4000', 'http://localhost:4001'],
    ['https://platform.example.com', 'https://api.platform.example.com'],
    ['https://platform.example.com/api', 'https://platform.example.com/'],
    ['http://localhost:4000', 'http://kindgi.localhost:4000'],
  ])('%s is not %s', (a, b) => {
    expect(sameAddress(a, b)).toBe(false);
    expect(sameAddress(b, a)).toBe(false);
  });

  test('text that is no URL is only the same as itself', () => {
    expect(sameAddress('not a url', 'not a url/')).toBe(true);
    expect(sameAddress('not a url', 'https://platform.example.com')).toBe(false);
  });
});

describe('isLocalAddress: an address on this machine', () => {
  test.each([
    'http://localhost:4000',
    'http://127.0.0.1:4000/',
    'http://[::1]:4000',
    ' http://LOCALHOST ',
  ])('%s is', (url) => {
    expect(isLocalAddress(url)).toBe(true);
  });

  test.each([
    'https://platform.example.com',
    'http://kindgi.localhost:4000',
    'http://10.0.0.5:4000',
    'localhost:4000',
    'not an address',
  ])('%s is not', (url) => {
    expect(isLocalAddress(url)).toBe(false);
  });
});
