<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deleting the plugin removes what it kept: the Kindgi URL, the
 * enrollment, the signing key it made, and each person's cached session.
 * Each person's subject and Kindgi id stay: they say who the person is.
 * Installed again and connected with a new code for the same site at
 * Kindgi, the site finds the same people there, with their history.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/** What the plugin kept on one site. */
function kindgi_uninstall_site(): void {
	global $wpdb;
	delete_option( 'kindgi_url' );
	delete_option( 'kindgi_site' );
	delete_option( 'kindgi_site_secret_key' );
	delete_metadata( 'user', 0, $wpdb->get_blog_prefix() . 'kindgi_session', '', true );
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
