<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The plugin's tests, with no WordPress and no test framework:
 * `php tests/run.php`. Each `test_…` function in `tests/test-*.php` is a
 * test, run from a fresh state (`kindgi_test_reset()`); it fails by throwing.
 */

require __DIR__ . '/bootstrap.php';

$kindgi_files = glob( __DIR__ . '/test-*.php' );
sort( $kindgi_files );
foreach ( $kindgi_files as $kindgi_file ) {
	require $kindgi_file;
}

$kindgi_ran    = 0;
$kindgi_failed = 0;
foreach ( get_defined_functions()['user'] as $kindgi_case ) {
	if ( 0 !== strpos( $kindgi_case, 'test_' ) ) {
		continue;
	}
	++$kindgi_ran;
	kindgi_test_reset();
	try {
		$kindgi_case();
		echo "ok   {$kindgi_case}\n";
	} catch ( Throwable $e ) {
		++$kindgi_failed;
		echo "FAIL {$kindgi_case}: {$e->getMessage()}\n";
	}
}

echo "{$kindgi_ran} tests, {$kindgi_failed} failed\n";
exit( $kindgi_ran > 0 && 0 === $kindgi_failed ? 0 : 1 );
