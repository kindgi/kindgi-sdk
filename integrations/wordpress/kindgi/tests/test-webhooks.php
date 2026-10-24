<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A WooCommerce webhook, as much of one as the plugin uses. */
final class Kindgi_Test_Webhook {
	public $id;
	public $name;
	public $url;
	public $status;
	public $failures;
	public $saved = 0;

	public function __construct( int $id, string $name, string $url, string $status, int $failures = 0 ) {
		$this->id       = $id;
		$this->name     = $name;
		$this->url      = $url;
		$this->status   = $status;
		$this->failures = $failures;
	}

	public function get_id() {
		return $this->id;
	}

	public function get_name() {
		return $this->name;
	}

	public function get_delivery_url() {
		return $this->url;
	}

	public function get_status() {
		return $this->status;
	}

	public function set_status( $status ) {
		$this->status = $status;
	}

	public function set_failure_count( $count ) {
		$this->failures = $count;
	}

	public function save() {
		++$this->saved;
	}
}

/** WooCommerce's webhook data store: the ids of the webhooks with a status. */
final class Kindgi_Test_Webhook_Store {
	public function get_webhooks_ids( $status = '' ) {
		$ids = array();
		// Before WooCommerce 3.6, the status asked for is ignored.
		$ignored = ! empty( $GLOBALS['kindgi_test']['webhooks_ignore_status'] );
		foreach ( $GLOBALS['kindgi_test']['webhooks'] as $webhook ) {
			if ( $ignored || '' === $status || $webhook->status === $status ) {
				$ids[] = $webhook->id;
			}
		}
		return $ids;
	}
}

final class WC_Data_Store {
	public static function load( $type ) {
		return new Kindgi_Test_Webhook_Store();
	}
}

function wc_get_webhook( $id ) {
	return $GLOBALS['kindgi_test']['webhooks'][ (int) $id ] ?? null;
}

const KINDGI_TEST_RECEIVE = 'https://kindgi.acme.example/v1/hooks/9126df1e-094b-496d-9ea8-7daab93c3f4f/wh_orders';

/** A store's webhooks: one to Kindgi turned off, one to Kindgi on, one elsewhere turned off. */
function kindgi_test_store_webhooks(): void {
	foreach ( array(
		new Kindgi_Test_Webhook( 3, 'Order created → Kindgi', KINDGI_TEST_RECEIVE, 'disabled', 6 ),
		new Kindgi_Test_Webhook( 4, 'Order updated → Kindgi', KINDGI_TEST_RECEIVE . '-updated', 'active' ),
		new Kindgi_Test_Webhook( 5, 'Order created → ERP', 'https://erp.acme.example/inbound/orders', 'disabled', 6 ),
	) as $webhook ) {
		$GLOBALS['kindgi_test']['webhooks'][ $webhook->id ] = $webhook;
	}
}

function test_webhooks_kindgis_receive_path_at_any_address(): void {
	foreach ( array(
		KINDGI_TEST_RECEIVE,
		'http://host.docker.internal:18701/v1/hooks/9126df1e-094b-496d-9ea8-7daab93c3f4f/wh_orders/',
		'https://acme-tunnel.example/v1/hooks/9126DF1E-094B-496D-9EA8-7DAAB93C3F4F/x?source=woo',
	) as $url ) {
		kindgi_assert( Kindgi_Webhooks::delivers_to_kindgi( $url ), "Kindgi's: $url" );
	}
	foreach ( array(
		'https://erp.acme.example/inbound/orders',
		'https://kindgi.acme.example/v1/hooks/not-a-tenant/wh_orders',
		'https://kindgi.acme.example/v1/hooks/9126df1e-094b-496d-9ea8-7daab93c3f4f',
		'https://kindgi.acme.example/v1/hooks/9126df1e-094b-496d-9ea8-7daab93c3f4f/a/b',
		'not a url',
	) as $url ) {
		kindgi_assert( ! Kindgi_Webhooks::delivers_to_kindgi( $url ), "not Kindgi's: $url" );
	}
}

function test_webhooks_lists_only_kindgis_that_woocommerce_turned_off_with_since_when(): void {
	kindgi_test_store_webhooks();
	kindgi_assert_same(
		array(
			array(
				'id'    => 3,
				'name'  => 'Order created → Kindgi',
				'since' => null,
			),
		),
		Kindgi_Webhooks::off(),
		"the one to Kindgi WooCommerce turned off, and only that one"
	);
	// WooCommerce's hook says when.
	Kindgi_Webhooks::turned_off( 3 );
	Kindgi_Webhooks::turned_off( 5 );
	$off = Kindgi_Webhooks::off();
	kindgi_assert( is_int( $off[0]['since'] ) && $off[0]['since'] >= time() - 5, 'dated' );
	kindgi_assert_same( array( 3 ), array_keys( get_option( Kindgi_Webhooks::DISABLED_AT ) ), "not the ERP's" );
}

function test_webhooks_turning_one_on_again_resets_its_refusals(): void {
	kindgi_test_store_webhooks();
	Kindgi_Webhooks::turned_off( 3 );
	kindgi_assert_same( null, Kindgi_Webhooks::turn_on( 3 ), 'turned on' );
	$webhook = $GLOBALS['kindgi_test']['webhooks'][3];
	kindgi_assert_same( 'active', $webhook->status, 'active' );
	// Left at 6, the next refusal would turn it off again at once.
	kindgi_assert_same( 0, $webhook->failures, 'its refusals counted from 0' );
	kindgi_assert_same( 1, $webhook->saved, 'saved' );
	kindgi_assert_same( array(), Kindgi_Webhooks::off(), 'none off' );
	kindgi_assert_same( array(), get_option( Kindgi_Webhooks::DISABLED_AT ), 'no date left' );
}

function test_webhooks_never_turns_on_one_that_isnt_kindgis(): void {
	kindgi_test_store_webhooks();
	kindgi_assert( is_string( Kindgi_Webhooks::turn_on( 5 ) ), "the ERP's: refused" );
	kindgi_assert_same( 'disabled', $GLOBALS['kindgi_test']['webhooks'][5]->status, 'left off' );
	kindgi_assert( is_string( Kindgi_Webhooks::turn_on( 99 ) ), 'no such webhook: refused' );
}

function test_webhooks_an_older_woocommerce_listing_every_webhook_still_shows_only_the_off_ones(): void {
	kindgi_test_store_webhooks();
	$GLOBALS['kindgi_test']['webhooks_ignore_status'] = true;
	kindgi_assert_same( array( 3 ), array_column( Kindgi_Webhooks::off(), 'id' ), 'not the active one to Kindgi' );
}
