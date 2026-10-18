<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Kindgi's API as one staff member: every call carries their own session,
 * so Kindgi's record names them, and what they may do is what their roles
 * on this site give them there.
 */
final class Kindgi_Api {

	/**
	 * One call as the person. When Kindgi has ended their kept session (a
	 * paused site, a new enrollment), they're signed in again once.
	 *
	 * @param WP_User    $user   The person.
	 * @param string     $method GET or POST.
	 * @param string     $path   Under the Kindgi URL.
	 * @param array      $query  Query parameters.
	 * @param array|null $body   A JSON body.
	 * @return array{status: int, body: array|null, retry_after: int|null, session: array}|WP_Error
	 */
	public static function call( WP_User $user, string $method, string $path, array $query = array(), ?array $body = null ) {
		$session = Kindgi_Sessions::for_user( $user );
		if ( is_wp_error( $session ) ) {
			return $session;
		}
		$response = Kindgi_Http::request( $method, $path, $query, $body, $session['token'] );
		if ( ! is_wp_error( $response ) && 401 === $response['status'] ) {
			Kindgi_Sessions::forget( $user->ID );
			$session = Kindgi_Sessions::sign_in( $user );
			if ( is_wp_error( $session ) ) {
				return $session;
			}
			$response = Kindgi_Http::request( $method, $path, $query, $body, $session['token'] );
		}
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$response['session'] = $session;
		return $response;
	}

	/**
	 * A call whose answer is the body, or Kindgi's refusal as a WP_Error.
	 *
	 * @param WP_User    $user   The person.
	 * @param string     $method GET or POST.
	 * @param string     $path   Under the Kindgi URL.
	 * @param array      $query  Query parameters.
	 * @param array|null $body   A JSON body.
	 * @return array{body: array, session: array}|WP_Error
	 */
	public static function body( WP_User $user, string $method, string $path, array $query = array(), ?array $body = null ) {
		$response = self::call( $user, $method, $path, $query, $body );
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		if ( $response['status'] < 200 || $response['status'] >= 300 ) {
			return Kindgi_Http::error( $response );
		}
		return array(
			'body'    => (array) $response['body'],
			'session' => $response['session'],
		);
	}
}
