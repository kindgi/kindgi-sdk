<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deleting the plugin removes what it kept: the Kindgi URL, the
 * enrollment, the signing key it made, each person's cached session, and
 * its scheduled runs. Each person's subject and Kindgi id stay, and so does
 * the list of people Kindgi knows, with any statement still waiting: they
 * say who the people are. Installed again and connected with a new code for
 * the same site at Kindgi, the site finds the same people there, with
 * their history, and tells Kindgi what it hadn't yet.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/** What the plugin kept on one site. */
function kindgi_uninstall_site(): void {
	global $wpdb;
	delete_option( 'kindgi_url' );
	delete_option( 'kindgi_site' );
	delete_option( 'kindgi_site_secret_key' );
	delete_metadata( 'user', 0, $wpdb->get_blog_prefix() . 'kindgi_session', '', true );
	delete_transient( 'kindgi_unreachable' );
	delete_option( 'kindgi_webhooks_disabled_at' );
	wp_clear_scheduled_hook( 'kindgi_people_retry' );
	wp_clear_scheduled_hook( 'kindgi_people_check' );
}

if ( is_multisite() ) {
	foreach ( get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	) as $kindgi_site_id ) {
		switch_to_blog( $kindgi_site_id );
		kindgi_uninstall_site();
		restore_current_blog();
	}
} else {
	kindgi_uninstall_site();
}
