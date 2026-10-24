<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Signs one statement for the interop test (`statement.test.mjs`):
 * `php tests/sign.php '<json>'` with `seed` (base64), `site`, `person`,
 * `now` and `jti`; prints `{ jwk, statement }`.
 */

require __DIR__ . '/bootstrap.php';
kindgi_test_reset();

$kindgi_in   = json_decode( $argv[1], true );
$kindgi_seed = base64_decode( $kindgi_in['seed'], true );
$kindgi_jwk  = Kindgi_Keys::jwk( $kindgi_seed );
echo json_encode(
	array(
		'jwk'       => $kindgi_jwk,
		'statement' => Kindgi_Statement::sign(
			Kindgi_Statement::claims( $kindgi_in['site'], $kindgi_in['person'], $kindgi_in['now'], $kindgi_in['jti'] ),
			$kindgi_jwk['kid'],
			Kindgi_Keys::secret_key( $kindgi_seed )
		),
	)
);
