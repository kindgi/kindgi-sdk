<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

function test_box_opens_what_it_sealed_and_nothing_else(): void {
	$key    = random_bytes( 32 );
	$sealed = Kindgi_Box::seal( '{"token":"kgi_sk_acme"}', $key );
	kindgi_assert( false === strpos( $sealed, 'kgi_sk_acme' ), 'the token never shows' );
	kindgi_assert_same( '{"token":"kgi_sk_acme"}', Kindgi_Box::open( $sealed, $key ), 'opened' );
	kindgi_assert_same( null, Kindgi_Box::open( $sealed, random_bytes( 32 ) ), 'another key (a changed salt)' );
	$bytes       = base64_decode( $sealed );
	$bytes[30]   = chr( ord( $bytes[30] ) ^ 1 );
	kindgi_assert_same( null, Kindgi_Box::open( base64_encode( $bytes ), $key ), 'tampered' );
	kindgi_assert_same( null, Kindgi_Box::open( 'not sealed', $key ), 'not a box' );
	kindgi_assert( Kindgi_Box::seal( 'same', $key ) !== Kindgi_Box::seal( 'same', $key ), 'a fresh nonce each time' );
}

function test_settings_compare_origins_as_browsers_do(): void {
	$cases = array(
		'https://acme-store.example/shop/'        => 'https://acme-store.example',
		'HTTPS://Acme-Store.EXAMPLE'               => 'https://acme-store.example',
		'https://acme-store.example:443/'          => 'https://acme-store.example',
		'http://acme-store.example:80'             => 'http://acme-store.example',
		'https://acme-store.example:8443/wp'       => 'https://acme-store.example:8443',
		'http://localhost:8080'                    => 'http://localhost:8080',
		'acme-store.example'                       => '',
	);
	foreach ( $cases as $url => $origin ) {
		kindgi_assert_same( $origin, Kindgi_Settings::origin_of( $url ), $url );
	}
}

function test_settings_an_enrollment_missing_a_field_is_none(): void {
	update_option( Kindgi_Settings::SITE_OPTION, array( 'site_id' => 'x' ) );
	kindgi_assert_same( null, Kindgi_Settings::site(), 'incomplete' );
}

function test_http_a_refusal_keeps_kindgis_code_reason_and_retry_and_a_401_is_a_403_here(): void {
	$error = Kindgi_Http::error(
		array(
			'status'      => 401,
			'body'        => array(
				'error' => array(
					'code'    => 'site-sign-in-refused',
					'message' => 'None of these roles may sign in through this site',
					'details' => array( 'reason' => 'role-not-allowed' ),
				),
			),
			'retry_after' => null,
		)
	);
	kindgi_assert_same( 'site-sign-in-refused', $error->get_error_code(), 'the code' );
	kindgi_assert_same( 'None of these roles may sign in through this site', $error->get_error_message(), 'the message' );
	kindgi_assert_same(
		array(
			'status' => 403,
			'reason' => 'role-not-allowed',
		),
		$error->get_error_data(),
		'the data'
	);
	$limited = Kindgi_Http::error(
		array(
			'status'      => 429,
			'body'        => null,
			'retry_after' => 30,
		)
	);
	kindgi_assert_same( 'kindgi_error', $limited->get_error_code(), 'no body, a code of our own' );
	kindgi_assert_same(
		array(
			'status'     => 429,
			'retryAfter' => 30,
		),
		$limited->get_error_data(),
		'429 passes, with its retry'
	);
	kindgi_assert_same( 502, Kindgi_Http::error( array( 'status' => 500, 'body' => null, 'retry_after' => null ) )->get_error_data()['status'], "Kindgi's 5xx is the store's 502" );
}
