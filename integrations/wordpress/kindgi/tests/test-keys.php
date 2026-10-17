<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** RFC 8037, appendix A: an Ed25519 key, its thumbprint, and a signature. */
const KINDGI_RFC8037_D          = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A';
const KINDGI_RFC8037_X          = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const KINDGI_RFC8037_THUMBPRINT = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
const KINDGI_RFC8037_INPUT      = 'eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc';
const KINDGI_RFC8037_SIGNATURE  = 'hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg';

function test_keys_the_rfc_8037_key_gives_its_public_half_and_thumbprint_as_the_kid(): void {
	$seed = Kindgi_Keys::decode( KINDGI_RFC8037_D );
	kindgi_assert( null !== $seed, 'the RFC seed decodes' );
	kindgi_assert_same(
		array(
			'kty' => 'OKP',
			'crv' => 'Ed25519',
			'x'   => KINDGI_RFC8037_X,
			'kid' => KINDGI_RFC8037_THUMBPRINT,
		),
		Kindgi_Keys::jwk( $seed ),
		'the JWK'
	);
}

function test_keys_sign_as_rfc_8037_does(): void {
	$secret = Kindgi_Keys::secret_key( Kindgi_Keys::decode( KINDGI_RFC8037_D ) );
	kindgi_assert_same(
		KINDGI_RFC8037_SIGNATURE,
		Kindgi_Statement::b64url( sodium_crypto_sign_detached( KINDGI_RFC8037_INPUT, $secret ) ),
		'the signature'
	);
}

function test_keys_a_seed_is_32_bytes_base64_or_base64url_and_nothing_else(): void {
	$bytes = random_bytes( 32 );
	kindgi_assert_same( $bytes, Kindgi_Keys::decode( base64_encode( $bytes ) ), 'base64' );
	kindgi_assert_same( $bytes, Kindgi_Keys::decode( ' ' . Kindgi_Statement::b64url( $bytes ) . "\n" ), 'base64url, trimmed' );
	kindgi_assert_same( null, Kindgi_Keys::decode( base64_encode( random_bytes( 31 ) ) ), '31 bytes' );
	kindgi_assert_same( null, Kindgi_Keys::decode( base64_encode( random_bytes( 64 ) ) ), '64 bytes' );
	kindgi_assert_same( null, Kindgi_Keys::decode( 'not a key!' ), 'not base64' );
}

function test_keys_come_from_the_environment_over_the_option_and_none_is_none(): void {
	kindgi_assert_same( '', Kindgi_Keys::source(), 'nothing yet' );
	kindgi_assert_same( null, Kindgi_Keys::seed(), 'no seed' );
	$kept = Kindgi_Keys::generate();
	Kindgi_Keys::keep( $kept );
	kindgi_assert_same( 'option', Kindgi_Keys::source(), 'the option' );
	kindgi_assert_same( $kept, Kindgi_Keys::seed(), 'the kept seed' );
	kindgi_assert( ! Kindgi_Keys::configured(), 'the option is the plugin\'s own' );
	$env = random_bytes( 32 );
	putenv( 'KINDGI_SITE_SECRET_KEY=' . base64_encode( $env ) );
	kindgi_assert_same( 'environment', Kindgi_Keys::source(), 'the environment wins' );
	kindgi_assert_same( $env, Kindgi_Keys::seed(), 'its seed' );
	kindgi_assert( Kindgi_Keys::configured(), 'the environment is configured' );
}

function test_keys_the_kid_is_the_keys_thumbprint_and_none_without_a_usable_key(): void {
	kindgi_assert_same( null, Kindgi_Keys::kid(), 'no key yet' );
	update_option( Kindgi_Keys::OPTION, KINDGI_RFC8037_D );
	kindgi_assert_same( KINDGI_RFC8037_THUMBPRINT, Kindgi_Keys::kid(), 'the kept key' );
	putenv( 'KINDGI_SITE_SECRET_KEY=too-short' );
	kindgi_assert_same( null, Kindgi_Keys::kid(), 'a malformed configured key' );
}

function test_keys_a_malformed_configured_key_is_an_error_never_a_new_key(): void {
	putenv( 'KINDGI_SITE_SECRET_KEY=too-short' );
	$seed = Kindgi_Keys::seed();
	kindgi_assert( is_wp_error( $seed ), 'an error' );
	kindgi_assert_same( 'kindgi_key_invalid', $seed->get_error_code(), 'its code' );
}
