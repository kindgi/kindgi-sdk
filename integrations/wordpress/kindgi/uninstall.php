<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deleting the plugin removes what it kept: the Kindgi URL, the
 * enrollment, the signing key it made, and each person's subject, Kindgi
 * id and cached session. Kindgi keeps its own record; a site installed
 * again connects with a new code, and its staff are new people there.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/** What the plugin kept on one site. */
function kindgi_uninstall_site(): void {
	global $wpdb;
	delete_option( 'kindgi_url' );
	delete_option( 'kindgi_site' );
	delete_option( 'kindgi_site_secret_key' );
	foreach ( array( 'kindgi_session', 'kindgi_subject', 'kindgi_user_id' ) as $key ) {
		delete_metadata( 'user', 0, $wpdb->get_blog_prefix() . $key, '', true );
	}
}

if ( is_multisite() ) {
	foreach ( get_sites( array( 'fields' => 'ids' ) ) as $kindgi_site_id ) {
		switch_to_blog( $kindgi_site_id );
		kindgi_uninstall_site();
		restore_current_blog();
	}
} else {
	kindgi_uninstall_site();
}
