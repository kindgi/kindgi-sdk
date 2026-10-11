<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Just enough of WordPress for the plugin's classes, written here (nothing
 * copied from WordPress): options and user options in memory, a WP_Error,
 * a WP_User, and the few functions the classes call.
 */

define( 'ABSPATH', __DIR__ . '/' );

$GLOBALS['kindgi_test'] = array();

/** Every test starts from no options, no user options, the site at https://acme-store.example, in production. */
function kindgi_test_reset(): void {
	$GLOBALS['kindgi_test'] = array(
		'options'      => array(),
		'user_options' => array(),
		'home'         => 'https://acme-store.example',
		'environment'  => 'production',
		'requests'     => array(),
	);
	putenv( 'KINDGI_SITE_SECRET_KEY' );
}

// Some hosts have no ext/sodium; WordPress then loads its bundled
// sodium_compat. KINDGI_SODIUM_COMPAT names a sodium_compat autoloader to
// run the tests on that path (CI's row without the extension).
$kindgi_compat = getenv( 'KINDGI_SODIUM_COMPAT' );
if ( is_string( $kindgi_compat ) && '' !== $kindgi_compat ) {
	require_once $kindgi_compat;
}

final class WP_Error {
	private $code;
	private $message;
	private $data;

	public function __construct( $code = '', $message = '', $data = '' ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}

	public function get_error_code() {
		return $this->code;
	}

	public function get_error_message() {
		return $this->message;
	}

	public function get_error_data() {
		return $this->data;
	}
}

final class WP_User {
	public $ID;
	public $display_name;
	public $user_email;
	public $roles;

	public function __construct( int $id, string $name, array $roles, string $email = '' ) {
		$this->ID           = $id;
		$this->display_name = $name;
		$this->roles        = $roles;
		$this->user_email   = $email;
	}
}

final class Kindgi_Test_Wpdb {
	public function get_blog_prefix(): string {
		return 'wp_';
	}
}
$GLOBALS['wpdb'] = new Kindgi_Test_Wpdb();

function is_wp_error( $thing ): bool {
	return $thing instanceof WP_Error;
}

function __( string $text, string $domain = 'default' ): string {
	return $text;
}

function get_option( string $name, $fallback = false ) {
	return array_key_exists( $name, $GLOBALS['kindgi_test']['options'] ) ? $GLOBALS['kindgi_test']['options'][ $name ] : $fallback;
}

function update_option( string $name, $value, $autoload = null ): bool {
	$GLOBALS['kindgi_test']['options'][ $name ] = $value;
	return true;
}

function add_option( string $name, $value = '', $deprecated = '', $autoload = null ): bool {
	if ( array_key_exists( $name, $GLOBALS['kindgi_test']['options'] ) ) {
		return false;
	}
	$GLOBALS['kindgi_test']['options'][ $name ] = $value;
	return true;
}

function get_user_option( string $name, int $user_id ) {
	return $GLOBALS['kindgi_test']['user_options'][ $user_id ][ 'wp_' . $name ] ?? false;
}

function update_user_option( int $user_id, string $name, $value ): bool {
	$GLOBALS['kindgi_test']['user_options'][ $user_id ][ 'wp_' . $name ] = $value;
	return true;
}

function delete_user_option( int $user_id, string $name ): bool {
	unset( $GLOBALS['kindgi_test']['user_options'][ $user_id ][ 'wp_' . $name ] );
	return true;
}

function add_user_meta( int $user_id, string $key, $value, bool $unique = false ) {
	if ( $unique && isset( $GLOBALS['kindgi_test']['user_options'][ $user_id ][ $key ] ) ) {
		return false;
	}
	$GLOBALS['kindgi_test']['user_options'][ $user_id ][ $key ] = $value;
	return 1;
}

function wp_parse_url( string $url ) {
	return parse_url( $url );
}

function home_url(): string {
	return $GLOBALS['kindgi_test']['home'];
}

/** No network in tests: each call is recorded, and answered as unreachable. */
function wp_remote_request( string $url, array $args ) {
	$GLOBALS['kindgi_test']['requests'][] = array( $url, $args );
	return new WP_Error( 'http_request_failed', 'no network in tests' );
}

function wp_get_environment_type(): string {
	return $GLOBALS['kindgi_test']['environment'];
}

function wp_salt( string $scheme = 'auth' ): string {
	return 'acme-test-salt-' . $scheme;
}

function wp_json_encode( $value ) {
	return json_encode( $value );
}

function apply_filters( string $hook, $value ) {
	return $value;
}

function is_email( string $email ) {
	return false !== filter_var( $email, FILTER_VALIDATE_EMAIL ) ? $email : false;
}

function wp_generate_uuid4(): string {
	$b    = random_bytes( 16 );
	$b[6] = chr( ord( $b[6] ) & 0x0f | 0x40 );
	$b[8] = chr( ord( $b[8] ) & 0x3f | 0x80 );
	return vsprintf( '%s%s-%s-%s-%s-%s%s%s', str_split( bin2hex( $b ), 4 ) );
}

/** Fails the test unless the two are identical. */
function kindgi_assert_same( $expected, $actual, string $what ): void {
	if ( $expected !== $actual ) {
		throw new RuntimeException( $what . ': expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) );
	}
}

/** Fails the test unless it holds. */
function kindgi_assert( bool $holds, string $what ): void {
	if ( ! $holds ) {
		throw new RuntimeException( $what );
	}
}

require_once dirname( __DIR__ ) . '/includes/class-kindgi-statement.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-box.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-keys.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-settings.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-http.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-sessions.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-api.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-rest.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-admin.php';
