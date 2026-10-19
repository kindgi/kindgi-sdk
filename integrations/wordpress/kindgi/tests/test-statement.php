<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A JWS part, decoded. */
function kindgi_test_part( string $jws, int $index ): array {
	$parts = explode( '.', $jws );
	return json_decode( base64_decode( strtr( $parts[ $index ], '-_', '+/' ) ), true );
}

function kindgi_test_site(): array {
	return array(
		'site_id'  => '7c1f3a52-9d84-4c1e-b6a0-2f5e8d9c0b17',
		'audience' => 'https://kindgi.acme.example',
	);
}

function test_statement_carries_the_claims_kindgi_checks_and_verifies_under_the_public_key(): void {
	$seed   = Kindgi_Keys::generate();
	$jwk    = Kindgi_Keys::jwk( $seed );
	$claims = Kindgi_Statement::claims(
		kindgi_test_site(),
		array(
			'subject' => 'b2f4c0de-1111-4222-8333-944455556666',
			'name'    => '  Jane  ',
			'roles'   => array( 'shop_manager' ),
			'email'   => 'jane@acme-store.example',
		),
		1760000000,
		'jti-1'
	);
	$jws    = Kindgi_Statement::sign( $claims, $jwk['kid'], Kindgi_Keys::secret_key( $seed ) );
	kindgi_assert_same(
		array(
			'alg' => 'EdDSA',
			'typ' => 'kindgi-site+jwt',
			'kid' => $jwk['kid'],
		),
		kindgi_test_part( $jws, 0 ),
		'the header'
	);
	kindgi_assert_same(
		array(
			'iss'   => '7c1f3a52-9d84-4c1e-b6a0-2f5e8d9c0b17',
			'aud'   => 'https://kindgi.acme.example',
			'sub'   => 'b2f4c0de-1111-4222-8333-944455556666',
			'iat'   => 1760000000,
			'exp'   => 1760000060,
			'jti'   => 'jti-1',
			'name'  => 'Jane',
			'roles' => array( 'shop_manager' ),
			'email' => 'jane@acme-store.example',
		),
		kindgi_test_part( $jws, 1 ),
		'the claims'
	);
	list( $header, $payload, $signature ) = explode( '.', $jws );
	kindgi_assert(
		sodium_crypto_sign_verify_detached(
			base64_decode( strtr( $signature, '-_', '+/' ) ),
			$header . '.' . $payload,
			Kindgi_Keys::public_key( $seed )
		),
		'the signature verifies'
	);
	kindgi_assert( 1 === preg_match( '/^[\w-]+\.[\w-]+\.[\w-]+$/', $jws ), 'compact, unpadded' );
}

function test_statement_sends_no_email_when_there_is_none(): void {
	$claims = Kindgi_Statement::claims(
		kindgi_test_site(),
		array(
			'subject' => 's',
			'name'    => 'Ada',
			'roles'   => array(),
			'email'   => '',
		),
		1,
		'j'
	);
	kindgi_assert( ! array_key_exists( 'email', $claims ), 'no email claim' );
	kindgi_assert_same( array(), $claims['roles'], 'no roles is an empty list' );
}

function test_statement_cuts_a_name_to_200_characters_never_mid_character(): void {
	$claims = Kindgi_Statement::claims(
		kindgi_test_site(),
		array(
			'subject' => 's',
			'name'    => str_repeat( 'ö', 250 ),
			'roles'   => array(),
		),
		1,
		'j'
	);
	kindgi_assert_same( str_repeat( 'ö', 200 ), $claims['name'], 'the name' );
}

function test_statement_stays_under_kindgis_4096_byte_cap_at_its_largest(): void {
	$seed   = Kindgi_Keys::generate();
	$claims = Kindgi_Statement::claims(
		kindgi_test_site(),
		array(
			'subject' => wp_generate_uuid4(),
			'name'    => str_repeat( '𝒜', 250 ),
			'roles'   => array( 'administrator', 'shop_manager', 'editor' ),
			'email'   => str_repeat( 'a', 64 ) . '@' . str_repeat( 'b', 250 ) . '.example',
		),
		time(),
		wp_generate_uuid4()
	);
	$body   = json_encode( array( 'statement' => Kindgi_Statement::sign( $claims, Kindgi_Keys::jwk( $seed )['kid'], Kindgi_Keys::secret_key( $seed ) ) ) );
	kindgi_assert( strlen( $body ) < 4096, 'the body is ' . strlen( $body ) . ' bytes' );
}
