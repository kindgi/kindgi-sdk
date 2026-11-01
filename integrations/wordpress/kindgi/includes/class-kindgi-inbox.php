<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * The Inbox: approvals as a store's people read them (what would happen, in
 * words, and whether it waits for them or for someone else), and how many
 * wait for the person, the count on the Kindgi menu and in the admin bar.
 */
final class Kindgi_Inbox {

	/** Kindgi's subject kind for a tool call waiting for a person. */
	const TOOL_CALL = 'tool-call:pending';

	/** Reviewer roles, lowest first: a role decides what it or a lower one needs. */
	const ROLES = array( 'standard', 'senior', 'admin' );

	/** The count's transient, per person, and how long it's kept: Kindgi is asked at most this often. */
	const COUNT     = 'kindgi_waiting_';
	const COUNT_TTL = 60;

	/** A card shows at most this many of a call's fields, each cut to this many characters. */
	const FACTS_MAX = 12;
	const VALUE_MAX = 300;

	public static function register(): void {
		add_filter( 'heartbeat_received', array( self::class, 'heartbeat' ), 10, 2 );
	}

	/**
	 * An approval as the page shows it.
	 *
	 * @param array       $a    Kindgi's approval.
	 * @param string      $me   The person's Kindgi id.
	 * @param string|null $role The person's reviewer role, null for none.
	 * @param callable    $who  `user:<id>` to a name on this site, or null for someone it didn't sign in.
	 */
	public static function card( array $a, string $me, ?string $role, callable $who ): array {
		$ref      = is_array( $a['subjectRef'] ?? null ) ? $a['subjectRef'] : array();
		$tool     = self::TOOL_CALL === ( $a['subjectKind'] ?? '' ) && is_string( $ref['toolId'] ?? null ) ? $ref['toolId'] : null;
		$decision = is_array( $a['decision'] ?? null ) ? $a['decision'] : null;
		$asked_by = is_string( $a['requestedBy'] ?? null ) ? $a['requestedBy'] : null;
		$pending  = 'pending' === ( $a['status'] ?? '' );
		$not_mine = $pending ? self::not_yours( $a, $me, $role ) : null;
		return array(
			'id'             => (string) ( $a['id'] ?? '' ),
			'heading'        => self::heading( $a, $tool ),
			'summary'        => self::summary( $a ),
			// What would run, always shown: a title can leave a field out.
			'facts'          => null === $tool ? array() : self::facts( $ref['arguments'] ?? null ),
			'status'         => (string) ( $a['status'] ?? '' ),
			'createdAt'      => (string) ( $a['createdAt'] ?? '' ),
			'expiresAt'      => is_string( $a['expiresAt'] ?? null ) ? $a['expiresAt'] : null,
			'asked'          => self::asked( $asked_by, $me, $who ),
			// Pending: 'you' when this person may decide it, else 'others' and why not.
			'waitsFor'       => $pending ? ( null === $not_mine ? 'you' : 'others' ) : null,
			'notYours'       => $not_mine,
			'conversationId' => null !== $tool && is_string( $ref['conversationId'] ?? null ) ? $ref['conversationId'] : null,
			// Kindgi's own words and ids, behind "Details".
			'details'        => array(
				'title'        => (string) ( $a['title'] ?? '' ),
				'description'  => is_string( $a['description'] ?? null ) ? $a['description'] : '',
				'toolId'       => $tool,
				'arguments'    => null === $tool ? null : ( $ref['arguments'] ?? null ),
				'agentId'      => null !== $tool && is_string( $ref['agentId'] ?? null ) ? $ref['agentId'] : null,
				'requiredRole' => (string) ( $a['requiredRole'] ?? '' ),
			),
			'decision'       => null === $decision ? null : array(
				'decision'  => (string) ( $decision['decision'] ?? '' ),
				'decidedAt' => (string) ( $decision['decidedAt'] ?? '' ),
				'reason'    => is_string( $decision['rationale'] ?? null ) ? $decision['rationale'] : null,
				'byMe'      => ( $decision['decidedBy'] ?? null ) === 'user:' . $me,
				'by'        => is_string( $decision['decidedBy'] ?? null ) ? $who( $decision['decidedBy'] ) : null,
			),
		);
	}

	/**
	 * Why a waiting approval isn't this person's to decide, or null when it
	 * is. Kindgi decides in the end: this only sorts the Inbox.
	 */
	public static function not_yours( array $a, string $me, ?string $role ): ?string {
		$required = (string) ( $a['requiredRole'] ?? 'standard' );
		if ( null === $role || ! in_array( $role, self::ROLES, true ) ) {
			return 'not-a-reviewer';
		}
		if ( true === ( $a['separateApprover'] ?? false ) && ( $a['requestedBy'] ?? null ) === 'user:' . $me ) {
			return 'you-asked';
		}
		if ( is_string( $a['assignedTo'] ?? null ) && $a['assignedTo'] !== $me ) {
			return 'assigned';
		}
		$needed = array_search( $required, self::ROLES, true );
		if ( false !== $needed && array_search( $role, self::ROLES, true ) < $needed ) {
			return 'needs-' . $required;
		}
		return null;
	}

	/**
	 * The card's heading: the approval's title, unless it's the one Kindgi
	 * gives every tool call ("HITL review: <tool>"), then the tool's name in words.
	 */
	public static function heading( array $a, ?string $tool ): string {
		$title = trim( (string) ( $a['title'] ?? '' ) );
		if ( '' !== $title && 0 !== strpos( $title, 'HITL review' ) ) {
			return $title;
		}
		if ( null !== $tool ) {
			return self::tool_name( $tool );
		}
		return '' !== $title ? $title : __( 'An approval', 'kindgi' );
	}

	/** The approval's description, unless it's the one Kindgi gives every tool call. */
	public static function summary( array $a ): string {
		$text = trim( is_string( $a['description'] ?? null ) ? $a['description'] : '' );
		return 1 === preg_match( '/^Tool call \S+ awaiting reviewer approval before dispatch\.$/', $text ) ? '' : $text;
	}

	/** A tool's id in words: its last part, `woo.refund-large` → "Refund large". */
	public static function tool_name( string $id ): string {
		$parts = explode( '.', $id );
		return self::words( (string) end( $parts ) );
	}

	/**
	 * A call's fields as label and value: `orderId` → "Order ID", a list
	 * or an object as its JSON, each cut short.
	 *
	 * @return array<int, array{label: string, value: string}>
	 */
	public static function facts( $arguments ): array {
		// An object's fields; a list (or nothing) has none to name. PHP 7.4 has no array_is_list().
		if ( ! is_array( $arguments ) || array_keys( $arguments ) === range( 0, count( $arguments ) - 1 ) ) {
			return array();
		}
		$facts = array();
		foreach ( array_slice( $arguments, 0, self::FACTS_MAX, true ) as $key => $value ) {
			$facts[] = array(
				'label' => self::words( (string) $key ),
				'value' => self::text_of( $value ),
			);
		}
		return $facts;
	}

	/** A field's name in words, as a label. */
	public static function words( string $name ): string {
		$words = strtolower( trim( (string) preg_replace( '/[\s_-]+/', ' ', (string) preg_replace( '/([a-z0-9])([A-Z])/', '$1 $2', $name ) ) ) );
		$words = (string) preg_replace( array( '/\bid\b/', '/\burl\b/' ), array( 'ID', 'URL' ), $words );
		return '' === $words ? $name : ucfirst( $words );
	}

	/** A value as text, cut short: a list of words or numbers joined, anything else as its JSON. */
	public static function text_of( $value ): string {
		if ( is_bool( $value ) ) {
			$text = $value ? __( 'yes', 'kindgi' ) : __( 'no', 'kindgi' );
		} elseif ( null === $value ) {
			$text = '—';
		} elseif ( is_scalar( $value ) ) {
			$text = (string) $value;
		} elseif ( array() !== $value && array_keys( $value ) === range( 0, count( $value ) - 1 ) && count( array_filter( $value, 'is_scalar' ) ) === count( $value ) ) {
			// A list of words or numbers reads as one.
			$text = implode( ', ', array_map( 'strval', $value ) );
		} else {
			$text = (string) wp_json_encode( $value );
		}
		return mb_strlen( $text ) > self::VALUE_MAX ? mb_substr( $text, 0, self::VALUE_MAX - 1 ) . '…' : $text;
	}

	/**
	 * Who asked: `you`, a `person` on this site (by name), someone `kindgi`
	 * knows that this site didn't sign in, or `none` recorded: a run no
	 * person started (a webhook, a schedule or a service account's key).
	 *
	 * @return array{kind: string, name: string|null}
	 */
	public static function asked( ?string $principal, string $me, callable $who ): array {
		if ( null === $principal || 0 !== strpos( $principal, 'user:' ) ) {
			return array(
				'kind' => 'none',
				'name' => null,
			);
		}
		if ( 'user:' . $me === $principal ) {
			return array(
				'kind' => 'you',
				'name' => null,
			);
		}
		$name = $who( $principal );
		return array(
			'kind' => null === $name ? 'kindgi' : 'person',
			'name' => $name,
		);
	}

	/** The count kept for the person, or null when there's none to show. */
	public static function kept_count( int $user_id ): ?int {
		$count = get_transient( self::COUNT . $user_id );
		return is_int( $count ) && $count >= 0 ? $count : null;
	}

	/** Forgets the person's count: the next heartbeat asks Kindgi again. */
	public static function forget_count( int $user_id ): void {
		delete_transient( self::COUNT . $user_id );
	}

	/**
	 * How many approvals wait for the person to decide, asked of Kindgi at
	 * most once a minute. Only someone who has used Kindgi from this site
	 * before is asked about: a page load never makes anyone a person there.
	 * Null when there's nothing to show (not connected, never signed in, or
	 * Kindgi didn't answer; a failure is kept for the minute too).
	 */
	public static function count( WP_User $user ): ?int {
		$kept = get_transient( self::COUNT . $user->ID );
		if ( is_int( $kept ) ) {
			return $kept >= 0 ? $kept : null;
		}
		if ( null === Kindgi_Settings::site() || ! is_string( get_user_option( Kindgi_Sessions::USER_ID, $user->ID ) ) ) {
			return null;
		}
		$count = self::ask_count( $user );
		set_transient( self::COUNT . $user->ID, null === $count ? -1 : $count, self::COUNT_TTL );
		return $count;
	}

	private static function ask_count( WP_User $user ): ?int {
		$who = Kindgi_Api::body( $user, 'GET', '/v1/identity/whoami' );
		if ( is_wp_error( $who ) ) {
			return null;
		}
		$role = is_string( $who['body']['reviewerRole'] ?? null ) ? $who['body']['reviewerRole'] : null;
		if ( null === $role ) {
			return 0;
		}
		$answer = Kindgi_Api::body(
			$user,
			'GET',
			'/v1/approvals',
			array(
				'scopeKind' => 'project',
				'scopeId'   => $who['session']['project_id'],
				'status'    => 'pending',
				'limit'     => 50,
			)
		);
		if ( is_wp_error( $answer ) ) {
			return null;
		}
		$me    = (string) $answer['session']['user_id'];
		$count = 0;
		foreach ( is_array( $answer['body']['data'] ?? null ) ? $answer['body']['data'] : array() as $a ) {
			if ( is_array( $a ) && null === self::not_yours( $a, $me, $role ) ) {
				++$count;
			}
		}
		return $count;
	}

	/** WordPress's heartbeat on an admin page asks for the count; it answers with it, or null. */
	public static function heartbeat( array $response, array $data ): array {
		if ( empty( $data['kindgi_inbox'] ) || ! Kindgi_Rest::allowed() ) {
			return $response;
		}
		$response['kindgi_inbox'] = self::count( wp_get_current_user() );
		return $response;
	}
}
