<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/*
 * Deleting the plugin removes everything it kept, as the README's "What
 * the plugin stores" lists it, except who each person is: their subject,
 * their Kindgi id, and the people Kindgi knows.
 */
function test_uninstall_removes_what_the_plugin_kept_and_keeps_who_people_are(): void {
	foreach ( array( 'kindgi_url', 'kindgi_site', 'kindgi_site_secret_key', 'kindgi_webhooks_disabled_at', Kindgi_Rest::OFFERED, 'kindgi_people' ) as $name ) {
		update_option( $name, 'kept' );
	}
	update_user_option( 7, 'kindgi_session', 'sealed' );
	update_user_option( 7, 'kindgi_subject', 's-7' );
	update_user_option( 7, 'kindgi_user_id', 'u-7' );
	update_user_option( 8, 'kindgi_session', 'sealed' );
	set_transient( 'kindgi_unreachable', 1 );
	set_transient( 'kindgi_runs_no_waits', 1 );
	wp_schedule_event( time(), 'hourly', 'kindgi_people_check' );
	wp_schedule_single_event( time(), 'kindgi_people_retry' );

	defined( 'WP_UNINSTALL_PLUGIN' ) || define( 'WP_UNINSTALL_PLUGIN', 'kindgi/kindgi.php' );
	require dirname( __DIR__ ) . '/uninstall.php';

	kindgi_assert_same( array( 'kindgi_people' ), array_keys( $GLOBALS['kindgi_test']['options'] ), 'every option it kept is gone, the people Kindgi knows aside' );
	kindgi_assert_same(
		array(
			7 => array(
				'wp_kindgi_subject' => 's-7',
				'wp_kindgi_user_id' => 'u-7',
			),
			8 => array(),
		),
		$GLOBALS['kindgi_test']['user_options'],
		"each person's cached session is gone; who they are stays"
	);
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['transients'], 'what it noted for a while' );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['cron'], 'and its scheduled runs' );
}
