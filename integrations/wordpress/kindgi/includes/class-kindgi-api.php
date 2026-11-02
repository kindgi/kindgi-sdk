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
		return is_wp_error( $response ) ? $response : self::answer( $response, $response['session'] );
	}

	/**
	 * A read on the person's kept session only, never a new sign-in: what
	 * every admin page asks in the background (the Inbox's count) mustn't
	 * send Kindgi the person's name again. Null when they have no live
	 * session, or Kindgi ended it (then it's forgotten, and the next
	 * Kindgi page they open signs them in).
	 *
	 * @param WP_User $user  The person.
	 * @param string  $path  Under the Kindgi URL.
	 * @param array   $query Query parameters.
	 * @return array{body: array, session: array}|WP_Error|null
	 */
	public static function kept_get( WP_User $user, string $path, array $query = array() ) {
		$session = Kindgi_Sessions::kept( $user->ID );
		if ( null === $session ) {
			return null;
		}
		$response = Kindgi_Http::request( 'GET', $path, $query, null, $session['token'] );
		if ( ! is_wp_error( $response ) && 401 === $response['status'] ) {
			Kindgi_Sessions::forget( $user->ID );
			return null;
		}
		return is_wp_error( $response ) ? $response : self::answer( $response, $session );
	}

	/** Kindgi's answer as its body, or its refusal as a WP_Error. */
	private static function answer( array $response, array $session ) {
		if ( $response['status'] < 200 || $response['status'] >= 300 ) {
			return Kindgi_Http::error( $response );
		}
		return array(
			'body'    => (array) $response['body'],
			'session' => $session,
		);
	}
}
