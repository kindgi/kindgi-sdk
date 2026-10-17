<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A site enrolled with this seed, as https://acme-store.example. */
function kindgi_test_enrolled( string $seed ): void {
	Kindgi_Keys::keep( $seed );
	Kindgi_Settings::keep_site(
		array(
			'site_id'     => '7c1f3a52-9d84-4c1e-b6a0-2f5e8d9c0b17',
			'audience'    => 'https://kindgi.acme.example',
			'kid'         => Kindgi_Keys::jwk( $seed )['kid'],
			'origin'      => 'https://acme-store.example',
			'enrolled_at' => 1760000000,
		)
	);
}

function test_sessions_a_person_keeps_one_subject_and_is_never_named_by_id_or_email(): void {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	$jane  = new WP_User( 7, 'Jane', array( 'shop_manager' ), 'jane@acme-store.example' );
	$first = kindgi_test_part( Kindgi_Sessions::statement_for( $jane ), 1 );
	$again = kindgi_test_part( Kindgi_Sessions::statement_for( $jane ), 1 );
	kindgi_assert( 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $first['sub'] ), 'a random UUID' );
	kindgi_assert_same( $first['sub'], $again['sub'], 'the same subject' );
	kindgi_assert( $first['jti'] !== $again['jti'], 'a fresh jti each time' );
	kindgi_assert_same( array( 'shop_manager' ), $first['roles'], 'their roles here' );
	kindgi_assert_same( 'jane@acme-store.example', $first['email'], 'their address, for notifications' );
	kindgi_assert_same( 60, $first['exp'] - $first['iat'], 'a minute' );
	$ada = kindgi_test_part( Kindgi_Sessions::statement_for( new WP_User( 8, 'Ada', array( 'administrator' ) ) ), 1 );
	kindgi_assert( $ada['sub'] !== $first['sub'], 'another person, another subject' );
	kindgi_assert( ! array_key_exists( 'email', $ada ), 'no address, no email claim' );
}

function test_sessions_a_copy_of_the_site_under_another_address_signs_nobody_in(): void {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	$GLOBALS['kindgi_test']['home'] = 'https://staging.acme-store.example';
	$refused                        = Kindgi_Sessions::statement_for( new WP_User( 7, 'Jane', array( 'shop_manager' ) ) );
	kindgi_assert( is_wp_error( $refused ), 'refused' );
	kindgi_assert_same( 'kindgi_origin_changed', $refused->get_error_code(), 'its code' );
	kindgi_assert_same( 409, $refused->get_error_data()['status'], 'its status' );
}

function test_sessions_the_same_origin_written_differently_still_signs(): void {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	$GLOBALS['kindgi_test']['home'] = 'HTTPS://Acme-Store.example:443/shop';
	kindgi_assert( is_string( Kindgi_Sessions::statement_for( new WP_User( 7, 'Jane', array( 'shop_manager' ) ) ) ), 'signed' );
}

function test_sessions_a_key_that_changed_since_enrollment_signs_nobody_in(): void {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	Kindgi_Keys::keep( Kindgi_Keys::generate() );
	$refused = Kindgi_Sessions::statement_for( new WP_User( 7, 'Jane', array( 'shop_manager' ) ) );
	kindgi_assert( is_wp_error( $refused ), 'refused' );
	kindgi_assert_same( 'kindgi_key_changed', $refused->get_error_code(), 'its code' );
}

function test_sessions_a_site_never_enrolled_signs_nobody_in(): void {
	$refused = Kindgi_Sessions::statement_for( new WP_User( 7, 'Jane', array( 'shop_manager' ) ) );
	kindgi_assert( is_wp_error( $refused ), 'refused' );
	kindgi_assert_same( 'kindgi_not_enrolled', $refused->get_error_code(), 'its code' );
}
