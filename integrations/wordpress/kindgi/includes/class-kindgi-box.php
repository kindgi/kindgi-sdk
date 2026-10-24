<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * A small secret box (libsodium `secretbox`) for what the plugin keeps in
 * the database but mustn't hand to whoever can only read it: each staff
 * member's cached Kindgi session. The key comes from `wp-config.php`'s
 * salts, which a database copy or a read-only SQL injection doesn't carry.
 */
final class Kindgi_Box {

	/**
	 * Sealed: a random nonce and the ciphertext, base64.
	 *
	 * @param string $plain The secret.
	 * @param string $key   32 bytes.
	 */
	public static function seal( string $plain, string $key ): string {
		$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		return base64_encode( $nonce . sodium_crypto_secretbox( $plain, $nonce, $key ) );
	}

	/**
	 * The secret, or null when the box isn't one sealed under this key (a
	 * changed salt, a tampered value): the caller then starts over.
	 *
	 * @param string $sealed From `seal()`.
	 * @param string $key    32 bytes.
	 */
	public static function open( string $sealed, string $key ): ?string {
		$bytes = base64_decode( $sealed, true );
		if ( false === $bytes || strlen( $bytes ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return null;
		}
		$nonce = substr( $bytes, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$plain = sodium_crypto_secretbox_open( substr( $bytes, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ), $nonce, $key );
		return false === $plain ? null : $plain;
	}
}
