<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * A staff member's Kindgi session: this site signs a statement about them
 * and Kindgi exchanges it for a 15-minute session as them, limited to the
 * site's project. The session is kept until a minute before it ends,
 * sealed (`Kindgi_Box`) under a key from `wp-config.php`'s salts.
 *
 * Kept per user and per site (user options), since a multisite network's
 * sites each enroll on their own.
 */
final class Kindgi_Sessions {

	/** The sealed session. */
	const SESSION = 'kindgi_session';

	/** The person's subject: a random UUID made the first time they sign in. */
	const SUBJECT = 'kindgi_subject';

	/** Kindgi's id for the person, from their last sign-in: names requesters on approvals. */
	const USER_ID = 'kindgi_user_id';

	/** A kept session is signed in again this many seconds before it ends. */
	const REFRESH_BEFORE = 60;

	/**
	 * The person's session: the kept one, or a new sign-in.
	 *
	 * @return array{token: string, expires_at: int, user_id: string, project_id: string}|WP_Error
	 */
	public static function for_user( WP_User $user ) {
		$kept = self::kept( $user->ID );
		return null !== $kept ? $kept : self::sign_in( $user );
	}

	/**
	 * A new session for the person.
	 *
	 * @return array{token: string, expires_at: int, user_id: string, project_id: string}|WP_Error
	 */
	public static function sign_in( WP_User $user ) {
		$statement = self::statement_for( $user );
		if ( is_wp_error( $statement ) ) {
			return $statement;
		}
		$response = Kindgi_Http::request( 'POST', '/v1/auth/site-sign-in', array(), array( 'statement' => $statement ) );
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		if ( 200 !== $response['status'] ) {
			return Kindgi_Http::error( $response );
		}
		$body = (array) $response['body'];
		if ( ! is_string( $body['token'] ?? null ) || ! is_string( $body['userId'] ?? null ) || ! is_string( $body['projectId'] ?? null ) ) {
			return new WP_Error( 'kindgi_bad_answer', __( "Kindgi's answer to a sign-in wasn't one.", 'kindgi' ), array( 'status' => 502 ) );
		}
		$expires = is_string( $body['expiresAt'] ?? null ) ? strtotime( $body['expiresAt'] ) : false;
		$session = array(
			'token'      => $body['token'],
			'expires_at' => false === $expires ? time() + self::REFRESH_BEFORE : $expires,
			'user_id'    => $body['userId'],
			'project_id' => $body['projectId'],
		);
		update_user_option( $user->ID, self::USER_ID, $session['user_id'] );
		update_user_option( $user->ID, self::SESSION, Kindgi_Box::seal( (string) wp_json_encode( $session ), self::box_key() ) );
		return $session;
	}

	/**
	 * The signed statement for the person, or why this site won't sign one.
	 *
	 * @return string|WP_Error
	 */
	public static function statement_for( WP_User $user ) {
		$site = Kindgi_Settings::site();
		if ( null === $site ) {
			return new WP_Error(
				'kindgi_not_enrolled',
				__( "This site isn't connected to Kindgi yet: an administrator connects it under Kindgi → Settings.", 'kindgi' ),
				array( 'status' => 503 )
			);
		}
		// A copy of the site (a staging clone of the database) never vouches as the original.
		$here = Kindgi_Settings::home_origin();
		if ( $here !== $site['origin'] ) {
			return new WP_Error(
				'kindgi_origin_changed',
				sprintf(
					/* translators: 1: the address the site was connected as, 2: its address now */
					__( "This site was connected to Kindgi as %1\$s and is now %2\$s, so it signs nobody in: a copy of a site never vouches as the original. If the site moved, connect it again with a new code.", 'kindgi' ),
					$site['origin'],
					$here
				),
				array( 'status' => 409 )
			);
		}
		$seed = Kindgi_Keys::seed();
		if ( is_wp_error( $seed ) ) {
			return $seed;
		}
		if ( null === $seed || Kindgi_Keys::jwk( $seed )['kid'] !== $site['kid'] ) {
			return new WP_Error(
				'kindgi_key_changed',
				__( "This site's key isn't the one it connected with: connect it again with a new code from Kindgi.", 'kindgi' ),
				array( 'status' => 409 )
			);
		}
		$claims = Kindgi_Statement::claims( $site, self::person( $user ), time(), wp_generate_uuid4() );
		return Kindgi_Statement::sign( $claims, $site['kid'], Kindgi_Keys::secret_key( $seed ) );
	}

	/** Forgets the person's kept session: the next call signs them in again. */
	public static function forget( int $user_id ): void {
		delete_user_option( $user_id, self::SESSION );
	}

	/** Forgets every kept session on this site (a new enrollment ends them all at Kindgi). */
	public static function forget_all(): void {
		global $wpdb;
		delete_metadata( 'user', 0, $wpdb->get_blog_prefix() . self::SESSION, '', true );
	}

	/**
	 * What the statement says about the person.
	 *
	 * @return array{subject: string, name: string, roles: string[], email: string}
	 */
	private static function person( WP_User $user ): array {
		$subject = get_user_option( self::SUBJECT, $user->ID );
		if ( ! is_string( $subject ) || '' === $subject ) {
			global $wpdb;
			// Unique: of two first sign-ins at once, the first subject kept is the one both use.
			add_user_meta( $user->ID, $wpdb->get_blog_prefix() . self::SUBJECT, wp_generate_uuid4(), true );
			$subject = (string) get_user_option( self::SUBJECT, $user->ID );
		}
		/**
		 * The address Kindgi mails this person about approvals waiting for
		 * them (never a sign-in address). Return '' to send none.
		 *
		 * @param string  $email The user's email.
		 * @param WP_User $user  The user.
		 */
		$email = apply_filters( 'kindgi_statement_email', $user->user_email, $user );
		return array(
			'subject' => $subject,
			'name'    => (string) $user->display_name,
			'roles'   => array_values( (array) $user->roles ),
			'email'   => is_string( $email ) && is_email( $email ) ? $email : '',
		);
	}

	/**
	 * The person's kept session, when there's one with over a minute left.
	 *
	 * @return array{token: string, expires_at: int, user_id: string, project_id: string}|null
	 */
	private static function kept( int $user_id ): ?array {
		$sealed = get_user_option( self::SESSION, $user_id );
		if ( ! is_string( $sealed ) || '' === $sealed ) {
			return null;
		}
		$plain   = Kindgi_Box::open( $sealed, self::box_key() );
		$session = null === $plain ? null : json_decode( $plain, true );
		if ( ! is_array( $session ) || ! isset( $session['token'], $session['expires_at'], $session['user_id'], $session['project_id'] ) ) {
			return null;
		}
		return (int) $session['expires_at'] - self::REFRESH_BEFORE > time() ? $session : null;
	}

	/** The box's key: from the auth salts in `wp-config.php`, never stored. */
	private static function box_key(): string {
		return hash_hmac( 'sha256', 'kindgi-session-cache', wp_salt( 'auth' ), true );
	}
}
