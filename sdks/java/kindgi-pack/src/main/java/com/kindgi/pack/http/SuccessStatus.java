// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

/** The inclusive HTTP status-code range the runtime treats as a successful response. */
public record SuccessStatus(int min, int max) {}
