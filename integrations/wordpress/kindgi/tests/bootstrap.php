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
		'answers'      => array(),
		'users'        => array(),
		'actions'      => array(),
		'cron'         => array(),
		'transients'   => array(),
		'webhooks'     => array(),
		'current_user' => new WP_User( 0, '', array() ),
		'caps'         => array(),
		'orders'       => array(),
	);
	putenv( 'KINDGI_SITE_SECRET_KEY' );
	kindgi_test_reset_request();
}

/** A new request: what `Kindgi_People` counts per request starts over; options and users stay. */
function kindgi_test_reset_request(): void {
	foreach ( array( 'changed' => array(), 'sent' => 0 ) as $name => $value ) {
		$property = new ReflectionProperty( Kindgi_People::class, $name );
		$property->setAccessible( true );
		$property->setValue( null, $value );
	}
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

/** A REST request: its parameters, read as WordPress's are (`$request['name']`). */
final class WP_REST_Request implements ArrayAccess {
	private $params;

	public function __construct( array $params = array() ) {
		$this->params = $params;
	}

	public function offsetExists( $key ): bool {
		return isset( $this->params[ $key ] );
	}

	#[\ReturnTypeWillChange]
	public function offsetGet( $key ) {
		return $this->params[ $key ] ?? null;
	}

	public function offsetSet( $key, $value ): void {
		$this->params[ $key ] = $value;
	}

	public function offsetUnset( $key ): void {
		unset( $this->params[ $key ] );
	}
}

/** WooCommerce's orders, as `orders` holds them; its order functions make a site a store (`Kindgi_Order::store`). */
class WC_Order {
	private $id;
	private $status;
	private $billing_email;
	/** The notes added, each `array( note, is_customer_note, added_by_user )`. */
	public $notes = array();

	public function __construct( int $id, string $status = 'processing', string $billing_email = '' ) {
		$this->id            = $id;
		$this->status        = $status;
		$this->billing_email = $billing_email;
	}

	public function get_id(): int {
		return $this->id;
	}

	public function get_status(): string {
		return $this->status;
	}

	public function get_billing_email(): string {
		return $this->billing_email;
	}

	public function add_order_note( string $note, int $is_customer_note = 0, bool $added_by_user = false ): int {
		$this->notes[] = array( $note, $is_customer_note, $added_by_user );
		return count( $this->notes );
	}
}

function wc_get_order( $order ) {
	$id = $order instanceof WC_Order ? $order->get_id() : (int) $order;
	return $GLOBALS['kindgi_test']['orders'][ $id ] ?? false;
}

/** The signed-in person (`current_user`) and what they may do (`caps`). */
function wp_get_current_user(): WP_User {
	return $GLOBALS['kindgi_test']['current_user'];
}

function get_current_user_id(): int {
	return wp_get_current_user()->ID;
}

function current_user_can( string $capability ): bool {
	return in_array( $capability, $GLOBALS['kindgi_test']['caps'], true );
}

/** No one this site signed in is found by their Kindgi id: names read as unknown. */
function get_users( array $args = array() ): array {
	return array();
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

function _n( string $single, string $plural, int $number, string $domain = 'default' ): string {
	return 1 === $number ? $single : $plural;
}

function esc_html( $text ): string {
	return htmlspecialchars( (string) $text, ENT_QUOTES, 'UTF-8' );
}

function esc_html__( string $text, string $domain = 'default' ): string {
	return esc_html( __( $text, $domain ) );
}

function esc_url( string $url ): string {
	return htmlspecialchars( $url, ENT_QUOTES, 'UTF-8' );
}

function admin_url( string $path = '' ): string {
	return home_url() . '/wp-admin/' . $path;
}

function number_format_i18n( $number ): string {
	return number_format( (float) $number );
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

function wp_parse_url( string $url, int $component = -1 ) {
	return parse_url( $url, $component );
}

function home_url(): string {
	return $GLOBALS['kindgi_test']['home'];
}

/**
 * No network in tests: each call is recorded, and answered with the next
 * answer a test queued (`kindgi_test_answer()`), else as unreachable.
 */
function wp_remote_request( string $url, array $args ) {
	$GLOBALS['kindgi_test']['requests'][] = array( $url, $args );
	if ( array() !== $GLOBALS['kindgi_test']['answers'] ) {
		return array_shift( $GLOBALS['kindgi_test']['answers'] );
	}
	return new WP_Error( 'http_request_failed', 'no network in tests' );
}

function wp_remote_retrieve_body( $response ): string {
	return (string) ( $response['body'] ?? '' );
}

function wp_remote_retrieve_response_code( $response ) {
	return $response['response']['code'] ?? '';
}

function wp_remote_retrieve_header( $response, string $name ) {
	return $response['headers'][ $name ] ?? '';
}

/** Users, by id: what `kindgi_test_user()` made and a test didn't delete. */
function get_userdata( int $user_id ) {
	return $GLOBALS['kindgi_test']['users'][ $user_id ] ?? false;
}

function get_user_by( string $field, $value ) {
	foreach ( $GLOBALS['kindgi_test']['users'] as $user ) {
		if ( 'email' === $field && $user->user_email === $value ) {
			return $user;
		}
	}
	return false;
}

function is_user_member_of_blog( int $user_id = 0, int $blog_id = 0 ): bool {
	return isset( $GLOBALS['kindgi_test']['users'][ $user_id ] );
}

function add_action( string $hook, $callback, int $priority = 10, int $args = 1 ): bool {
	$GLOBALS['kindgi_test']['actions'][ $hook ][] = $callback;
	return true;
}

/** wp-cron: each hook's next run. */
function wp_next_scheduled( string $hook ) {
	return $GLOBALS['kindgi_test']['cron'][ $hook ] ?? false;
}

function wp_schedule_single_event( int $timestamp, string $hook ): bool {
	$GLOBALS['kindgi_test']['cron'][ $hook ] = min( $timestamp, $GLOBALS['kindgi_test']['cron'][ $hook ] ?? PHP_INT_MAX );
	return true;
}

function wp_schedule_event( int $timestamp, string $recurrence, string $hook ): bool {
	$GLOBALS['kindgi_test']['cron'][ $hook ] = $timestamp;
	return true;
}

function wp_clear_scheduled_hook( string $hook ): int {
	unset( $GLOBALS['kindgi_test']['cron'][ $hook ] );
	return 1;
}

/**
 * Transients as WordPress keeps them without an object cache, in the
 * options table: an array comes back as it was set, a number as text.
 */
function set_transient( string $name, $value, int $expiration = 0 ): bool {
	$GLOBALS['kindgi_test']['transients'][ $name ] = is_array( $value ) || is_object( $value ) ? serialize( $value ) : (string) $value;
	return true;
}

function get_transient( string $name ) {
	$stored = $GLOBALS['kindgi_test']['transients'][ $name ] ?? null;
	if ( null === $stored ) {
		return false;
	}
	return 1 === preg_match( '/^[aO]:\d+:/', $stored ) ? unserialize( $stored ) : $stored;
}

function delete_transient( string $name ): bool {
	unset( $GLOBALS['kindgi_test']['transients'][ $name ] );
	return true;
}

function wp_get_environment_type(): string {
	return $GLOBALS['kindgi_test']['environment'];
}

function wp_salt( string $scheme = 'auth' ): string {
	return 'acme-test-salt-' . $scheme;
}

function wp_json_encode( $value, int $flags = 0 ) {
	return json_encode( $value, $flags );
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
require_once dirname( __DIR__ ) . '/includes/class-kindgi-people.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-webhooks.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-api.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-inbox.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-mail.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-activity.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-rest.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-admin.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-order.php';
require_once dirname( __DIR__ ) . '/includes/class-kindgi-dashboard.php';
