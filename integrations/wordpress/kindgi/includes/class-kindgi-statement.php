<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * The site's statement about one of its people: a compact JWS (EdDSA,
 * `typ: kindgi-site+jwt`) that Kindgi exchanges for a 15-minute session as
 * that person, limited to the site's project.
 *
 * Short and used once: it lives 60 seconds and carries a fresh `jti`.
 * The person is their `sub`, a random UUID this site keeps for them, never
 * their numeric id, login name or email, which can change or be reused.
 *
 * - **Every statement about someone here carries their name:** Kindgi
 *   shows a person as the latest statement names them, and one with no
 *   name as "A person, via <site>".
 * - **A statement that says the person left** (`removed`, with no roles)
 *   gets no session: Kindgi retires the person for good and ends their
 *   grants, reviewer role and sessions (`Kindgi_People`).
 */
final class Kindgi_Statement {

	/** The statement's media type, which Kindgi checks. */
	const TYP = 'kindgi-site+jwt';

	/** How long a statement is good for, in seconds: Kindgi refuses longer. */
	const LIFETIME = 60;

	/** At most this many characters of a name are sent. */
	const NAME_MAX = 200;

	/** At most this many roles are sent: a statement stays under Kindgi's 4 KB. */
	const ROLES_MAX = 20;

	/**
	 * The claims for one person.
	 *
	 * @param array  $site   The enrolled site: `site_id` and `audience`.
	 * @param array  $person `subject`, `name`, `roles` (this site's), and `email` ('' for none);
	 *                       `removed` when the person left this site (their user deleted, removed
	 *                       from it or erased), which Kindgi takes as for good.
	 * @param int    $now    Seconds since the epoch.
	 * @param string $jti    A fresh, unique id for this statement.
	 * @return array
	 */
	public static function claims( array $site, array $person, int $now, string $jti ): array {
		$claims = array(
			'iss'   => (string) $site['site_id'],
			'aud'   => (string) $site['audience'],
			'sub'   => (string) $person['subject'],
			'iat'   => $now,
			'exp'   => $now + self::LIFETIME,
			'jti'   => $jti,
			'name'  => self::name( (string) $person['name'] ),
			'roles' => array_slice( array_values( array_map( 'strval', (array) $person['roles'] ) ), 0, self::ROLES_MAX ),
		);
		if ( isset( $person['email'] ) && '' !== $person['email'] ) {
			$claims['email'] = (string) $person['email'];
		}
		if ( ! empty( $person['removed'] ) ) {
			$claims['removed'] = true;
		}
		return $claims;
	}

	/**
	 * The signed statement.
	 *
	 * @param array  $claims     From `claims()`.
	 * @param string $kid        The key's id, as enrolled.
	 * @param string $secret_key The 64-byte Ed25519 secret key.
	 * @return string The compact JWS.
	 */
	public static function sign( array $claims, string $kid, string $secret_key ): string {
		$header  = self::b64url(
			self::json(
				array(
					'alg' => 'EdDSA',
					'typ' => self::TYP,
					'kid' => $kid,
				)
			)
		);
		$payload = self::b64url( self::json( $claims ) );
		$input   = $header . '.' . $payload;
		return $input . '.' . self::b64url( sodium_crypto_sign_detached( $input, $secret_key ) );
	}

	/** Base64url, unpadded (RFC 7515). */
	public static function b64url( string $bytes ): string {
		return rtrim( strtr( base64_encode( $bytes ), '+/', '-_' ), '=' );
	}

	/** A name, trimmed and cut to `NAME_MAX` characters. Kindgi cleans it further. */
	private static function name( string $name ): string {
		$name = trim( $name );
		return function_exists( 'mb_substr' ) ? mb_substr( $name, 0, self::NAME_MAX, 'UTF-8' ) : substr( $name, 0, self::NAME_MAX );
	}

	/** JSON for a JWS part: slashes and Unicode as they are; bad UTF-8 replaced, never dropped. */
	private static function json( array $value ): string {
		$json = json_encode( $value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE );
		if ( false === $json ) {
			throw new RuntimeException( 'kindgi: a statement could not be encoded as JSON' );
		}
		return $json;
	}
}
