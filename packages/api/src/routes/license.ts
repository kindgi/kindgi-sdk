// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { AppEnv } from '../types.js';

/**
 * Where the deployment's license key stands, as its startup banner says
 * it: what the console shows from 30 days before the key expires, with the
 * same way to the next key. Never the key itself.
 */
export interface LicenseStatus {
  /** `development`: `KINDGI_DEV`, no key needed (the rest is absent). */
  readonly mode: 'development' | 'licensed';
  /** Whose key: the name the banner prints. */
  readonly name?: string;
  readonly use?: 'production' | 'non-production';
  /** ISO 8601. */
  readonly expiresAt?: string;
  /** Whole days until it expires; negative once it has. */
  readonly daysLeft?: number;
  /** `expiring`: 30 days or fewer left; `grace`: expired, and the runtime still starts with it. */
  readonly standing?: 'valid' | 'expiring' | 'grace';
  /** How to get the next key, as the banner says it; present from 30 days before it expires. */
  readonly renew?: string;
}

/** The deployment's license status, worked out on each read (the days left move). */
export interface LicenseStatusBinding {
  status(): LicenseStatus | Promise<LicenseStatus>;
}

/**
 * `GET /v1/license`: where the deployment's license key stands. Any signed-in
 * caller may read it: the console warns everyone who uses it, from 30 days
 * before the key expires, so someone renews it in time.
 */
export function licenseRouter(binding: LicenseStatusBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', async (c) => c.json(await binding.status()));
  return r;
}
