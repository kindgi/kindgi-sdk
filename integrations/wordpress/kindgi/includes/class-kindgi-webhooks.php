<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * WooCommerce webhooks that deliver to Kindgi, and the ones WooCommerce
 * turned off.
 *
 * WooCommerce turns a webhook off after 7 refused deliveries in a row (its
 * `woocommerce_max_webhook_delivery_failures`, 5, is checked before the
 * count goes up), and never resends a delivery. Where Kindgi limits
 * webhook receives (Kindgi hosted does; a self-hosted runtime only when its
 * operator sets a limit), it refuses a delivery past the limit with 429 and
 * `Retry-After`, which WooCommerce counts as a failure like any other. So a webhook to Kindgi can go quiet
 * after a burst, and nothing reaches Kindgi until someone turns it on
 * again: the settings page says so, with the way to do it.
 *
 * A webhook is Kindgi's when its delivery URL has Kindgi's receive path
 * (`/v1/hooks/<tenant id>/<webhook id>`), whatever the address: a store may
 * reach Kindgi through a tunnel or a public address of its own.
 */
final class Kindgi_Webhooks {

	/** The settings page's form action that turns one back on. */
	const ENABLE = 'kindgi_enable_webhook';

	/** When WooCommerce turned each Kindgi webhook off, by id (its hook says; WooCommerce keeps no date). */
	const DISABLED_AT = 'kindgi_webhooks_disabled_at';

	/** Kindgi's receive path: `/v1/hooks/<tenant id>/<webhook id>`. */
	const RECEIVE_PATH = '#/v1/hooks/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+/?$#i';

	public static function register(): void {
		add_action( 'woocommerce_webhook_disabled_due_delivery_failures', array( self::class, 'turned_off' ) );
		add_action( 'admin_post_' . self::ENABLE, array( self::class, 'enable' ) );
	}

	/** Whether a delivery URL is Kindgi's receive URL. */
	public static function delivers_to_kindgi( string $url ): bool {
		$path = wp_parse_url( $url, PHP_URL_PATH );
		return is_string( $path ) && 1 === preg_match( self::RECEIVE_PATH, $path );
	}

	/**
	 * The Kindgi webhooks WooCommerce has turned off; none without
	 * WooCommerce.
	 *
	 * @return array<int, array{id: int, name: string, since: int|null}>
	 */
	public static function off(): array {
		$since = (array) get_option( self::DISABLED_AT, array() );
		$off   = array();
		foreach ( self::kindgis( 'disabled' ) as $webhook ) {
			$id    = (int) $webhook->get_id();
			$off[] = array(
				'id'    => $id,
				'name'  => (string) $webhook->get_name(),
				'since' => isset( $since[ $id ] ) ? (int) $since[ $id ] : null,
			);
		}
		return $off;
	}

	/** How many Kindgi webhooks WooCommerce delivers; null without WooCommerce. */
	public static function on(): ?int {
		if ( ! self::woocommerce() ) {
			return null;
		}
		return count( self::kindgis( 'active' ) );
	}

	/** How many Kindgi webhooks someone paused in WooCommerce; none without WooCommerce. */
	public static function paused(): int {
		return count( self::kindgis( 'paused' ) );
	}

	/**
	 * WooCommerce's webhooks with a status that deliver to Kindgi.
	 *
	 * @return WC_Webhook[]
	 */
	private static function kindgis( string $status ): array {
		if ( ! self::woocommerce() ) {
			return array();
		}
		$kindgis = array();
		foreach ( (array) WC_Data_Store::load( 'webhook' )->get_webhooks_ids( $status ) as $id ) {
			$webhook = wc_get_webhook( (int) $id );
			// Its own status too: before WooCommerce 3.6 the list ignores the status asked for.
			if ( ! $webhook || $status !== $webhook->get_status() ) {
				continue;
			}
			if ( self::delivers_to_kindgi( (string) $webhook->get_delivery_url() ) ) {
				$kindgis[] = $webhook;
			}
		}
		return $kindgis;
	}

	private static function woocommerce(): bool {
		return class_exists( 'WC_Data_Store' ) && function_exists( 'wc_get_webhook' );
	}

	/** WooCommerce's hook: a webhook turned off after refused deliveries. Kindgi's are dated. */
	public static function turned_off( $webhook_id ): void {
		$webhook = function_exists( 'wc_get_webhook' ) ? wc_get_webhook( (int) $webhook_id ) : null;
		if ( ! $webhook || ! self::delivers_to_kindgi( (string) $webhook->get_delivery_url() ) ) {
			return;
		}
		$since                       = (array) get_option( self::DISABLED_AT, array() );
		$since[ (int) $webhook_id ] = time();
		update_option( self::DISABLED_AT, $since, false );
	}

	/**
	 * Turns one back on, from the settings page: active, with its count of
	 * refused deliveries back to 0. Left as it was (WooCommerce's own edit
	 * screen leaves it), the next refusal would turn it off again at once.
	 *
	 * @return string|null Why not, or null when it's on.
	 */
	public static function turn_on( int $webhook_id ): ?string {
		$webhook = function_exists( 'wc_get_webhook' ) ? wc_get_webhook( $webhook_id ) : null;
		if ( ! $webhook || ! self::delivers_to_kindgi( (string) $webhook->get_delivery_url() ) ) {
			return __( "That isn't a WooCommerce webhook that delivers to Kindgi.", 'kindgi' );
		}
		$webhook->set_status( 'active' );
		$webhook->set_failure_count( 0 );
		$webhook->save();
		$since = (array) get_option( self::DISABLED_AT, array() );
		unset( $since[ $webhook_id ] );
		update_option( self::DISABLED_AT, $since, false );
		return null;
	}

	/** The settings page's "Turn it on again" button. */
	public static function enable(): void {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( "You may not change this store's webhooks.", 'kindgi' ), 403 );
		}
		check_admin_referer( self::ENABLE );
		$refused = self::turn_on( absint( $_POST['webhook'] ?? 0 ) );
		Kindgi_Admin::done(
			null === $refused ? 'ok' : 'error',
			null === $refused
				? __( "Turned on again. Orders from before now that WooCommerce didn't send aren't resent.", 'kindgi' )
				: $refused
		);
	}

	/** Where WooCommerce edits a webhook. */
	public static function edit_url( int $webhook_id ): string {
		return admin_url( 'admin.php?page=wc-settings&tab=advanced&section=webhooks&edit-webhook=' . $webhook_id );
	}
}
