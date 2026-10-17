<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * The site's signing key: an Ed25519 key pair from a 32-byte seed. Only
 * the public half ever leaves WordPress, once, when the site enrolls.
 *
 * Where the seed lives, in order:
 * 1. the `KINDGI_SITE_SECRET_KEY` constant, set in `wp-config.php`;
 * 2. the `KINDGI_SITE_SECRET_KEY` environment variable;
 * 3. a database option the plugin keeps at enrollment, not autoloaded; a
 *    new one each time the site connects again.
 *
 * The first two are preferred: a copy of the database (a backup, a staging
 * clone) carries the option, never `wp-config.php` or the environment.
 * Either holds the seed base64-encoded:
 * `php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'`.
 */
final class Kindgi_Keys {

	/** The constant's and environment variable's name. */
	const NAME = 'KINDGI_SITE_SECRET_KEY';

	/** The fallback option. */
	const OPTION = 'kindgi_site_secret_key';

	/** Where the seed comes from: `constant`, `environment`, `option`, or `` when there's none yet. */
	public static function source(): string {
		if ( defined( self::NAME ) && '' !== (string) constant( self::NAME ) ) {
			return 'constant';
		}
		$env = getenv( self::NAME );
		if ( is_string( $env ) && '' !== $env ) {
			return 'environment';
		}
		return '' !== (string) get_option( self::OPTION, '' ) ? 'option' : '';
	}

	/**
	 * The 32-byte seed; null when there's none yet; a WP_Error when the one
	 * configured isn't 32 bytes, base64.
	 *
	 * @return string|null|WP_Error
	 */
	public static function seed() {
		switch ( self::source() ) {
			case 'constant':
				$value = (string) constant( self::NAME );
				break;
			case 'environment':
				$value = (string) getenv( self::NAME );
				break;
			case 'option':
				$value = (string) get_option( self::OPTION, '' );
				break;
			default:
				return null;
		}
		$seed = self::decode( $value );
		if ( null === $seed ) {
			return new WP_Error(
				'kindgi_key_invalid',
				sprintf(
					/* translators: %s: KINDGI_SITE_SECRET_KEY */
					__( '%s must be 32 random bytes, base64-encoded.', 'kindgi' ),
					self::NAME
				)
			);
		}
		return $seed;
	}

	/** Whether the seed comes from `wp-config.php` or the environment, which the plugin never changes. */
	public static function configured(): bool {
		return in_array( self::source(), array( 'constant', 'environment' ), true );
	}

	/** A new seed, not kept yet: `keep()` it once Kindgi has taken its public key. */
	public static function generate(): string {
		return random_bytes( SODIUM_CRYPTO_SIGN_SEEDBYTES );
	}

	/** Keeps a seed in the fallback option, not autoloaded: read only when the site signs. */
	public static function keep( string $seed ): void {
		update_option( self::OPTION, base64_encode( $seed ), false );
	}

	/** The 64-byte secret key for signing. */
	public static function secret_key( string $seed ): string {
		return sodium_crypto_sign_secretkey( sodium_crypto_sign_seed_keypair( $seed ) );
	}

	/** The 32-byte public key. */
	public static function public_key( string $seed ): string {
		return sodium_crypto_sign_publickey( sodium_crypto_sign_seed_keypair( $seed ) );
	}

	/**
	 * The public key as Kindgi takes it at enrollment: an OKP JWK whose
	 * `kid` is its RFC 7638 thumbprint, so a changed key is a changed id.
	 */
	public static function jwk( string $seed ): array {
		$x = Kindgi_Statement::b64url( self::public_key( $seed ) );
		return array(
			'kty' => 'OKP',
			'crv' => 'Ed25519',
			'x'   => $x,
			'kid' => self::thumbprint( $x ),
		);
	}

	/** The site key's id, as Kindgi lists the site's keys; null when there's no key, or the one configured is malformed. */
	public static function kid(): ?string {
		$seed = self::seed();
		return is_string( $seed ) ? self::jwk( $seed )['kid'] : null;
	}

	/** RFC 7638: SHA-256 over the required members, in order, with no whitespace. */
	public static function thumbprint( string $x ): string {
		return Kindgi_Statement::b64url( hash( 'sha256', '{"crv":"Ed25519","kty":"OKP","x":"' . $x . '"}', true ) );
	}

	/** 32 bytes from base64 or base64url, or null. */
	public static function decode( string $value ): ?string {
		$value = trim( $value );
		$bytes = base64_decode( strtr( $value, '-_', '+/' ), true );
		return false !== $bytes && SODIUM_CRYPTO_SIGN_SEEDBYTES === strlen( $bytes ) ? $bytes : null;
	}
}
