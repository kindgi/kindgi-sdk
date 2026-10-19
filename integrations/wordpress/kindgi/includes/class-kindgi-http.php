<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Calls to Kindgi, server to server, through WordPress's HTTP API. No
 * Kindgi token ever reaches a browser.
 */
final class Kindgi_Http {

	/** Seconds before a call to Kindgi gives up. */
	const TIMEOUT = 20;

	/**
	 * One call.
	 *
	 * @param string      $method GET or POST.
	 * @param string      $path   Under the Kindgi URL, e.g. `/v1/approvals`.
	 * @param array       $query  Query parameters (scalars).
	 * @param array|null  $body   A JSON body.
	 * @param string|null $token  The bearer token, if any.
	 * @param string|null $base   Another Kindgi URL than the one set (connecting to a new one).
	 * @return array{status: int, body: array|null, retry_after: int|null}|WP_Error
	 */
	public static function request( string $method, string $path, array $query = array(), ?array $body = null, ?string $token = null, ?string $base = null ) {
		$base = rtrim( null === $base ? Kindgi_Settings::url() : trim( $base ), '/' );
		if ( '' === $base ) {
			return new WP_Error(
				'kindgi_not_configured',
				__( "Kindgi's URL isn't set: an administrator sets it under Kindgi → Settings.", 'kindgi' ),
				array( 'status' => 503 )
			);
		}
		if ( ! Kindgi_Settings::url_allowed( $base ) ) {
			return new WP_Error(
				'kindgi_url_insecure',
				__( "Kindgi's URL must be https://. An http:// URL works only on this computer (localhost) or from a local or development site.", 'kindgi' ),
				array( 'status' => 503 )
			);
		}
		$url = $base . $path;
		if ( array() !== $query ) {
			$url .= '?' . http_build_query( $query, '', '&', PHP_QUERY_RFC3986 );
		}
		$headers = array( 'Accept' => 'application/json' );
		if ( null !== $token ) {
			$headers['Authorization'] = 'Bearer ' . $token;
		}
		$args = array(
			'method'      => $method,
			'timeout'     => self::TIMEOUT,
			'redirection' => 0,
			'headers'     => $headers,
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}
		$response = wp_remote_request( $url, $args );
		if ( is_wp_error( $response ) ) {
			return new WP_Error(
				'kindgi_unreachable',
				sprintf(
					/* translators: %s: the error from WordPress's HTTP API */
					__( "Kindgi couldn't be reached: %s", 'kindgi' ),
					$response->get_error_message()
				),
				array( 'status' => 502 )
			);
		}
		$text        = wp_remote_retrieve_body( $response );
		$decoded     = '' === $text ? null : json_decode( $text, true );
		$retry_after = wp_remote_retrieve_header( $response, 'retry-after' );
		return array(
			'status'      => (int) wp_remote_retrieve_response_code( $response ),
			'body'        => is_array( $decoded ) ? $decoded : null,
			'retry_after' => is_numeric( $retry_after ) ? (int) $retry_after : null,
		);
	}

	/**
	 * Kindgi's refusal as a WP_Error: its code and message, the reason it
	 * gave (`details.reason`), and the status the store's own route answers.
	 *
	 * @param array $response From `request()`.
	 */
	public static function error( array $response ): WP_Error {
		$error   = is_array( $response['body']['error'] ?? null ) ? $response['body']['error'] : array();
		$code    = is_string( $error['code'] ?? null ) ? $error['code'] : 'kindgi_error';
		$message = is_string( $error['message'] ?? null )
			? $error['message']
			: sprintf(
				/* translators: %d: an HTTP status */
				__( 'Kindgi answered %d.', 'kindgi' ),
				$response['status']
			);
		$data = array( 'status' => self::status_for( $response['status'] ) );
		if ( is_string( $error['details']['reason'] ?? null ) ) {
			$data['reason'] = $error['details']['reason'];
		}
		if ( null !== $response['retry_after'] ) {
			$data['retryAfter'] = $response['retry_after'];
		}
		return new WP_Error( $code, $message, $data );
	}

	/**
	 * The status the store's route answers: Kindgi's 4xx pass through,
	 * except a 401, which is Kindgi refusing someone WordPress signed in (a
	 * 403 here, so the browser never takes it for a lapsed WordPress login);
	 * anything else is the store's 502.
	 */
	private static function status_for( int $status ): int {
		if ( 401 === $status ) {
			return 403;
		}
		return $status >= 400 && $status < 500 ? $status : 502;
	}
}
