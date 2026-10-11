<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Where Kindgi is, and what this site enrolled as.
 *
 * - The Kindgi URL this server calls: the `KINDGI_URL` constant, else the
 *   `kindgi_url` option set on the settings page. It may differ from the
 *   public URL a statement names as its audience (a runtime the store
 *   reaches on a private network, say).
 * - The enrollment: the site's id, the audience Kindgi gave, the key's id,
 *   and this site's own origin then. A site whose address changed since
 *   (a staging copy of the database) signs nobody in.
 */
final class Kindgi_Settings {

	/** The constant that sets the Kindgi URL, over the option. */
	const URL_CONSTANT = 'KINDGI_URL';

	/** The option the settings page keeps the Kindgi URL in. */
	const URL_OPTION = 'kindgi_url';

	/** The enrollment: `site_id`, `audience`, `kid`, `origin`, `enrolled_at`. */
	const SITE_OPTION = 'kindgi_site';

	/** The Kindgi URL, with no trailing slash; '' when none is set. */
	public static function url(): string {
		$url = defined( self::URL_CONSTANT ) ? (string) constant( self::URL_CONSTANT ) : (string) get_option( self::URL_OPTION, '' );
		return rtrim( trim( $url ), '/' );
	}

	/** Whether the URL comes from `wp-config.php` (the settings page then only shows it). */
	public static function url_is_constant(): bool {
		return defined( self::URL_CONSTANT );
	}

	/**
	 * The enrollment, or null before the site enrolls.
	 *
	 * @return array{site_id: string, audience: string, kid: string, origin: string, enrolled_at: int}|null
	 */
	public static function site(): ?array {
		$site = get_option( self::SITE_OPTION, null );
		if ( ! is_array( $site ) ) {
			return null;
		}
		foreach ( array( 'site_id', 'audience', 'kid', 'origin' ) as $key ) {
			if ( ! isset( $site[ $key ] ) || ! is_string( $site[ $key ] ) || '' === $site[ $key ] ) {
				return null;
			}
		}
		return $site;
	}

	/** Keeps an enrollment. */
	public static function keep_site( array $site ): void {
		update_option( self::SITE_OPTION, $site, true );
	}

	/**
	 * A URL's origin, as browsers compare them: `scheme://host[:port]`,
	 * lowercased, with a default port left out. '' when it has none.
	 */
	public static function origin_of( string $url ): string {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		$scheme  = strtolower( $parts['scheme'] );
		$host    = strtolower( $parts['host'] );
		$default = ( 'https' === $scheme && 443 === ( $parts['port'] ?? 443 ) ) || ( 'http' === $scheme && 80 === ( $parts['port'] ?? 80 ) );
		return $scheme . '://' . $host . ( $default || ! isset( $parts['port'] ) ? '' : ':' . $parts['port'] );
	}

	/** This site's origin now. */
	public static function home_origin(): string {
		return self::origin_of( home_url() );
	}

	/** The approvals URL to register this site with in Kindgi: an approval's link lands here. */
	public static function approvals_url(): string {
		return admin_url( 'admin.php?page=kindgi&approval={approvalId}' );
	}
}
