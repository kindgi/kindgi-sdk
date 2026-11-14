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

function test_settings_kindgi_url_is_https_or_http_only_here_or_on_a_development_site(): void {
	foreach ( array( 'https://kindgi.acme.example', 'http://localhost:8080', 'http://127.0.0.1:18701', 'http://[::1]:8080', 'http://kindgi.localhost' ) as $url ) {
		kindgi_assert( Kindgi_Settings::url_allowed( $url ), "allowed: $url" );
	}
	foreach ( array( 'http://kindgi.acme.example', 'http://10.0.0.5:8080', 'ftp://kindgi.acme.example', 'kindgi.acme.example', '' ) as $url ) {
		kindgi_assert( ! Kindgi_Settings::url_allowed( $url ), "refused in production: $url" );
	}
	$GLOBALS['kindgi_test']['environment'] = 'local';
	kindgi_assert( Kindgi_Settings::url_allowed( 'http://host.docker.internal:18701' ), 'http on a local site' );
	$sent = Kindgi_Http::request( 'GET', '/v1/x', array(), null, null, 'http://kindgi.acme.example' );
	kindgi_assert_same( 'kindgi_unreachable', $sent->get_error_code(), 'sent on a local site (and unreachable here)' );
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['requests'] ), 'one request' );
	$GLOBALS['kindgi_test']['environment'] = 'production';
	$refused = Kindgi_Http::request( 'GET', '/v1/x', array(), null, null, 'http://kindgi.acme.example' );
	kindgi_assert_same( 'kindgi_url_insecure', $refused->get_error_code(), 'refused in production' );
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['requests'] ), 'nothing sent over plain http in production' );
}

function test_rest_a_new_conversation_names_the_sites_project_only_for_a_shared_agent(): void {
	kindgi_assert_same( null, Kindgi_Rest::named_project( 'p-store', 'p-store' ), "the site's own agent: unnamed, so no write is needed" );
	kindgi_assert_same( 'p-store', Kindgi_Rest::named_project( 'p-store', 'p-agency' ), "an agent shared from another project: opened in the site's" );
	kindgi_assert_same( null, Kindgi_Rest::named_project( 'p-store', null ), 'an agent with no project: unnamed' );
	kindgi_assert_same( null, Kindgi_Rest::named_project( 'p-store', '' ), 'an empty project: unnamed' );
}

function test_rest_a_turn_goes_only_into_the_persons_own_conversation(): void {
	kindgi_assert( Kindgi_Rest::owns( array( 'participantId' => 'u-jane' ), 'u-jane' ), "Jane's own" );
	kindgi_assert( ! Kindgi_Rest::owns( array( 'participantId' => 'u-ada' ), 'u-jane' ), "Ada's, refused to Jane" );
	kindgi_assert( ! Kindgi_Rest::owns( array(), 'u-jane' ), 'no participant, refused' );
	kindgi_assert( ! Kindgi_Rest::owns( array( 'participantId' => '' ), '' ), 'no person, refused' );
}

function test_sessions_are_sealed_under_the_signing_key_when_it_is_outside_the_database(): void {
	$salted = hash_hmac( 'sha256', 'kindgi-session-cache', wp_salt( 'auth' ), true );
	Kindgi_Keys::keep( Kindgi_Keys::generate() );
	kindgi_assert_same( $salted, Kindgi_Sessions::box_key(), 'the key in the database: the salts seal them' );
	$seed = random_bytes( 32 );
	putenv( 'KINDGI_SITE_SECRET_KEY=' . base64_encode( $seed ) );
	kindgi_assert_same( hash_hmac( 'sha256', 'kindgi-session-cache', $seed, true ), Kindgi_Sessions::box_key(), 'the key outside it: made from the key' );
	kindgi_assert( Kindgi_Sessions::box_key() !== $seed, 'never the signing key itself' );
}

function test_statement_sends_at_most_20_roles(): void {
	$claims = Kindgi_Statement::claims(
		kindgi_test_site(),
		array(
			'subject' => 's',
			'name'    => 'Ada',
			'roles'   => array_map( fn( $i ) => "role-$i", range( 1, 30 ) ),
		),
		1,
		'j'
	);
	kindgi_assert_same( 20, count( $claims['roles'] ), 'twenty' );
	kindgi_assert_same( 'role-1', $claims['roles'][0], 'the first ones' );
}

function test_sodium_is_the_one_this_run_asked_for(): void {
	$compat = getenv( 'KINDGI_SODIUM_COMPAT' );
	if ( is_string( $compat ) && '' !== $compat ) {
		kindgi_assert( ! extension_loaded( 'sodium' ), 'no ext/sodium on the sodium_compat run' );
		kindgi_assert( class_exists( 'ParagonIE_Sodium_Compat' ), 'sodium_compat loaded' );
	} else {
		kindgi_assert( extension_loaded( 'sodium' ), 'ext/sodium' );
	}
}

function test_rest_a_long_conversation_shows_its_newest_messages(): void {
	$pages = array(
		null => array( 'data' => array_map( fn( $i ) => array( 'sequence' => $i ), range( 0, 59 ) ), 'hasMore' => true, 'nextCursor' => 'c1' ),
		'c1' => array( 'data' => array_map( fn( $i ) => array( 'sequence' => $i ), range( 60, 119 ) ), 'hasMore' => true, 'nextCursor' => 'c2' ),
		'c2' => array( 'data' => array_map( fn( $i ) => array( 'sequence' => $i ), range( 120, 149 ) ), 'hasMore' => false ),
	);
	$asked = array();
	$read  = Kindgi_Rest::newest_messages(
		function ( ?string $cursor ) use ( $pages, &$asked ) {
			$asked[] = $cursor;
			return $pages[ null === $cursor ? '' : $cursor ];
		}
	);
	kindgi_assert_same( array( null, 'c1', 'c2' ), $asked, 'every page, in order' );
	kindgi_assert_same( 100, count( $read['rows'] ), 'the newest hundred' );
	kindgi_assert_same( 50, $read['rows'][0]['sequence'], 'from 50' );
	kindgi_assert_same( 149, $read['rows'][99]['sequence'], 'to the newest' );
	kindgi_assert( $read['earlier'], 'earlier ones not shown' );
	$short = Kindgi_Rest::newest_messages( fn( $cursor ) => array( 'data' => array( array( 'sequence' => 0 ) ), 'hasMore' => false ) );
	kindgi_assert( ! $short['earlier'], 'a short one shows whole' );
	$failed = Kindgi_Rest::newest_messages( fn( $cursor ) => new WP_Error( 'kindgi_unreachable', 'down' ) );
	kindgi_assert( is_wp_error( $failed ), 'a failed page fails the read' );
}

function test_admin_the_page_needs_more_than_writing_posts(): void {
	kindgi_assert_same( 'edit_others_posts', Kindgi_Admin::capability(), 'without WooCommerce: editors and administrators' );
}

function test_admin_the_privacy_guide_has_the_staffs_part_then_the_shoppers_with_the_privacy_policys_address(): void {
	$text = Kindgi_Admin::privacy_policy_text();
	$staff = strpos( $text, '<p class="privacy-policy-tutorial">Use this part if your site&#039;s staff use the Kindgi pages.' );
	$shoppers = strpos( $text, '<p class="privacy-policy-tutorial">Use this part if your store sends Kindgi WooCommerce webhooks' );
	kindgi_assert( 0 === $staff, 'the staff\'s part comes first, its note to the owner in the guide\'s tutorial class' );
	kindgi_assert( false !== $shoppers && $shoppers > $staff, 'then the shoppers\' part' );
	kindgi_assert( 2 === substr_count( $text, '<strong class="privacy-policy-tutorial">Suggested text: </strong>' ), 'each part has its suggested text' );
	kindgi_assert( 2 === substr_count( $text, 'Its privacy policy is at https://www.kindgi.com/privacy.]' ), 'both give the privacy policy\'s address' );
	kindgi_assert( false === strpos( $text, 'privacy URL' ), 'no placeholder is left, as text or as a tag' );
}

function test_admin_a_retired_key_set_by_hand_says_where_to_set_a_new_one_and_anything_else_keeps_kindgis_words(): void {
	$retired  = new WP_Error( 'site-enrollment-key-retired', "This key was retired at this site, or at another site at its address, so it can't be enrolled again: enroll a new key. The code wasn't used up, so it works until it expires." );
	$constant = Kindgi_Admin::connect_error( $retired, 'constant' );
	kindgi_assert( false !== strpos( $constant, 'Set a new KINDGI_SITE_SECRET_KEY in wp-config.php' ), 'the constant: wp-config.php' );
	kindgi_assert( false !== strpos( $constant, "php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'" ), 'the constant: how to make one' );
	$environment = Kindgi_Admin::connect_error( $retired, 'environment' );
	kindgi_assert( false !== strpos( $environment, "Set a new KINDGI_SITE_SECRET_KEY in the server's environment" ), 'the environment' );
	kindgi_assert( false === strpos( $environment, 'wp-config.php' ), 'the environment: not wp-config.php' );
	foreach ( array( $constant, $environment ) as $words ) {
		kindgi_assert( 0 === strpos( $words, "Kindgi won't take this site's key again: it was retired." ), 'why first' );
		kindgi_assert( false === strpos( $words, '%' ), 'no format code left in the words' );
		$last = ' The same code works until it expires.';
		kindgi_assert( substr( $words, -strlen( $last ) ) === $last, 'the same code still works, last' );
	}
	kindgi_assert_same( $retired->get_error_message(), Kindgi_Admin::connect_error( $retired, 'option' ), "a key kept in the database: Kindgi's words" );
	kindgi_assert_same( $retired->get_error_message(), Kindgi_Admin::connect_error( $retired, '' ), "no key yet: Kindgi's words" );
	$refused = new WP_Error( 'site-enrollment-refused', 'That enrollment code is wrong, used or expired, or its site is paused: ask a tenant admin for a new one' );
	kindgi_assert_same( $refused->get_error_message(), Kindgi_Admin::connect_error( $refused, 'constant' ), "another refusal: Kindgi's words" );
}
