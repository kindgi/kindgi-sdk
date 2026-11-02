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

	/** An approval waits while it's in one of these states; it's closed in the others. */
	const WAITING = array( 'pending', 'assigned', 'in_review' );
	const CLOSED  = array( 'approved', 'rejected', 'expired', 'withdrawn', 'escalated' );

	/** A count reads one page of what waits, this long. */
	const COUNT_PAGE = 50;

	/**
	 * The count's transient, per person, and how long it's kept: Kindgi is
	 * asked at most this often. It's kept as an array, which WordPress
	 * hands back as it was set: a number comes back as text from the
	 * options table, and as a number from an object cache.
	 */
	const COUNT     = 'kindgi_waiting_';
	const COUNT_TTL = 60;

	/** A card shows at most this many of a call's fields, each cut to this many characters. */
	const FACTS_MAX = 12;
	const VALUE_MAX = 300;

	/** The agent's own words (a draft to a customer) are read in full, up to this many characters. */
	const WORDS_MAX = 4000;

	public static function register(): void {
		add_filter( 'heartbeat_received', array( self::class, 'heartbeat' ), 10, 2 );
	}

	/**
	 * An approval as the page shows it.
	 *
	 * @param array         $a          Kindgi's approval.
	 * @param string        $me         The person's Kindgi id.
	 * @param array|null    $reviewer   The person as a reviewer (`reviewer_of`), null when they can't decide.
	 * @param callable      $who        `user:<id>` to a name on this site, or null for someone it didn't sign in.
	 * @param callable|null $agent_name An agent's id to its name at Kindgi, or null when it has none there.
	 */
	public static function card( array $a, string $me, ?array $reviewer, callable $who, ?callable $agent_name = null ): array {
		$ref      = is_array( $a['subjectRef'] ?? null ) ? $a['subjectRef'] : array();
		$tool     = self::TOOL_CALL === ( $a['subjectKind'] ?? '' ) && is_string( $ref['toolId'] ?? null ) ? $ref['toolId'] : null;
		// Someone's approve or reject; a withdrawal or a pass to another reviewer reads as the approval's state.
		$decision = is_array( $a['decision'] ?? null ) && in_array( $a['decision']['decision'] ?? null, array( 'approve', 'reject' ), true ) ? $a['decision'] : null;
		$asked_by = is_string( $a['requestedBy'] ?? null ) ? $a['requestedBy'] : null;
		$pending  = in_array( $a['status'] ?? null, self::WAITING, true );
		$not_mine = $pending ? self::not_yours( $a, $me, $reviewer ) : null;
		$prose    = null === $tool ? array() : self::prose_of( $ref['arguments'] ?? null );
		$reply    = null === $tool ? null : self::reply_of( $ref['arguments'] ?? null );
		$heading  = self::heading( $a, $tool, $reply );
		$summary  = self::summary( $a );
		$asked    = self::asked( $asked_by, $me, $who );
		$agent_id = null !== $tool && is_string( $ref['agentId'] ?? null ) ? $ref['agentId'] : null;
		$card     = array(
			'id'             => (string) ( $a['id'] ?? '' ),
			'heading'        => $heading,
			// A summary that's one of the agent's own fields shows once, as its words (compared whole, before either is cut).
			'summary'        => in_array( $summary, $prose, true ) ? '' : $summary,
			// What would run, always shown: a title can leave a field out. A reply's heading may name whom it goes to.
			'facts'          => null === $tool ? array() : self::facts( $ref['arguments'] ?? null, null !== $reply && self::reply_heading( $reply ) === $heading ? array( 'to' ) : array() ),
			// The agent's own words among them (a reason, a note): quoted, apart from the facts.
			'words'          => self::words_of( $ref['arguments'] ?? null, $prose, null === $reply ? array() : array( 'body' => __( 'The reply', 'kindgi' ) ) ),
			// A mail tool's reply: whom it goes to.
			'reply'          => $reply,
			// The whole call, folded, when the facts and words leave part of it out.
			'whole'          => null === $tool ? null : self::whole( $ref['arguments'] ?? null ),
			'status'         => (string) ( $a['status'] ?? '' ),
			'createdAt'      => (string) ( $a['createdAt'] ?? '' ),
			'expiresAt'      => is_string( $a['expiresAt'] ?? null ) ? $a['expiresAt'] : null,
			// Who it goes to if no one decides by then; null: it expires then.
			'next'           => self::next_reviewer( $a ),
			'asked'          => $asked,
			// The agent that asked on its own, when no person did: its name at Kindgi, else its id in words.
			'agent'          => null === $agent_id || 'none' !== $asked['kind'] ? null : ( ( null === $agent_name ? null : $agent_name( $agent_id ) ) ?? self::tool_name( $agent_id ) ),
			// Waiting: 'you' when this person may decide it, else 'others' and why not.
			'waitsFor'       => $pending ? ( null === $not_mine ? 'you' : 'others' ) : null,
			'notYours'       => $not_mine,
			'conversationId' => null !== $tool && is_string( $ref['conversationId'] ?? null ) ? $ref['conversationId'] : null,
			// What it's about, when its tool says (a WooCommerce order: `Kindgi_Order`).
			'about'          => self::about_of( $a ),
			'decision'       => null === $decision ? null : array(
				'decision'  => (string) ( $decision['decision'] ?? '' ),
				'decidedAt' => (string) ( $decision['decidedAt'] ?? '' ),
				'reason'    => is_string( $decision['rationale'] ?? null ) ? $decision['rationale'] : null,
				'byMe'      => ( $decision['decidedBy'] ?? null ) === 'user:' . $me,
				'by'        => is_string( $decision['decidedBy'] ?? null ) ? $who( $decision['decidedBy'] ) : null,
			),
		);
		// Its conversation opens for its reviewer, and for whoever asked (it's theirs).
		$card['opens'] = null !== $card['conversationId'] && ( self::reviews( $card ) || 'you' === $card['asked']['kind'] );
		return $card;
	}

	/**
	 * Whether the person is the approval's reviewer: it waits for them to
	 * decide, or they decided it. Its conversation then opens for them to
	 * read, whoever's it is.
	 */
	public static function reviews( array $card ): bool {
		return 'you' === $card['waitsFor'] || ( null !== $card['decision'] && true === $card['decision']['byMe'] );
	}

	/**
	 * Why a waiting approval isn't this person's to decide, or null when it
	 * is. Kindgi decides in the end: this only sorts the Inbox.
	 *
	 * @param array      $a        Kindgi's approval.
	 * @param string     $me       The person's Kindgi id.
	 * @param array|null $reviewer The person as a reviewer (`reviewer_of`), null when they can't decide.
	 */
	public static function not_yours( array $a, string $me, ?array $reviewer ): ?string {
		if ( null === $reviewer ) {
			return 'not-a-reviewer';
		}
		if ( true === ( $a['separateApprover'] ?? false ) && ( $a['requestedBy'] ?? null ) === 'user:' . $me ) {
			return 'you-asked';
		}
		// An approval assigned to a reviewer names their row on the roster, not their user.
		if ( is_string( $a['assignedTo'] ?? null ) && $a['assignedTo'] !== $reviewer['id'] ) {
			return 'assigned';
		}
		$required = (string) ( $a['requiredRole'] ?? 'standard' );
		return in_array( $required, $reviewer['decides'], true ) ? null : 'needs-' . $required;
	}

	/**
	 * Who a waiting approval goes to if no one decides it by its deadline:
	 * Kindgi passes it to the reviewer tier above its own (`senior`, then
	 * `admin`), with as long again to decide. Null when it expires then
	 * instead, and what it asks for doesn't happen: at the top tier, or
	 * addressed to one person (`approver`).
	 */
	public static function next_reviewer( array $a ): ?string {
		if ( is_array( $a['approver'] ?? null ) ) {
			return null;
		}
		$required = (string) ( $a['requiredRole'] ?? 'standard' );
		if ( 'standard' === $required ) {
			return 'senior';
		}
		return 'senior' === $required ? 'admin' : null;
	}

	/**
	 * The person as a reviewer, from Kindgi's `GET /v1/identity/me/permissions`:
	 * their row on the roster (`id`, the one an approval assigned to them
	 * names) and the required roles they may decide. Null when they can't
	 * decide any: no reviewer role, or a role without a row on the roster.
	 *
	 * @return array{id: string|null, role: string, decides: string[]}|null
	 */
	public static function reviewer_of( array $permissions ): ?array {
		$r = is_array( $permissions['reviewer'] ?? null ) ? $permissions['reviewer'] : null;
		if ( null === $r || true !== ( $r['canDecide'] ?? null ) || ! is_string( $r['role'] ?? null ) ) {
			return null;
		}
		return array(
			'id'      => is_string( $r['id'] ?? null ) ? $r['id'] : null,
			'role'    => $r['role'],
			'decides' => array_values( array_filter( is_array( $r['decides'] ?? null ) ? $r['decides'] : array(), 'is_string' ) ),
		);
	}

	/**
	 * The card's heading: the tool's own title for the call, when it gave
	 * one (Kindgi puts it in the approval's `context.text`); else the
	 * approval's title, unless it's one Kindgi gives every tool call; then
	 * a mail tool's reply by whom it goes to, or the tool's name in words.
	 *
	 * @param array{to: string}|null $reply `reply_of` the call.
	 */
	public static function heading( array $a, ?string $tool, ?array $reply = null ): string {
		$own = self::own_words( $a, 'title' );
		if ( null !== $own ) {
			return $own;
		}
		$title = trim( (string) ( $a['title'] ?? '' ) );
		if ( '' !== $title && ! self::generic_title( $title, $tool ) ) {
			return $title;
		}
		if ( null !== $reply ) {
			return self::reply_heading( $reply );
		}
		if ( null !== $tool ) {
			return self::tool_name( $tool );
		}
		return '' !== $title ? $title : __( 'An approval', 'kindgi' );
	}

	/** "Reply to pat@example.com": a mail tool's reply, by whom it goes to. */
	private static function reply_heading( array $reply ): string {
		/* translators: %s: an email address */
		return sprintf( __( 'Reply to %s', 'kindgi' ), $reply['to'] );
	}

	/**
	 * Whether a title is one Kindgi gives every tool call: "Approve a call
	 * to <tool>", or "HITL review: <tool>" from a runtime before it.
	 */
	public static function generic_title( string $title, ?string $tool ): bool {
		return 0 === strpos( $title, 'HITL review' ) || ( null !== $tool && 'Approve a call to ' . $tool === $title );
	}

	/**
	 * The tool's own summary for the call, when it gave one; else the
	 * approval's description, unless it's the one Kindgi gives every tool call.
	 */
	public static function summary( array $a ): string {
		$own = self::own_words( $a, 'summary' );
		if ( null !== $own ) {
			return $own;
		}
		$text = trim( is_string( $a['description'] ?? null ) ? $a['description'] : '' );
		return 1 === preg_match( '/^Tool call \S+ awaiting reviewer approval before dispatch\.$/', $text ) ? '' : $text;
	}

	/**
	 * What an approval is about, when its tool says (Kindgi puts it in the
	 * approval's `context.about`): a kind, `woocommerce.order`, and an id.
	 *
	 * @return array{kind: string, id: string}|null
	 */
	public static function about_of( array $a ): ?array {
		$about = is_array( $a['context']['about'] ?? null ) ? $a['context']['about'] : array();
		$kind  = is_string( $about['kind'] ?? null ) ? trim( $about['kind'] ) : '';
		$id    = is_string( $about['id'] ?? null ) || is_int( $about['id'] ?? null ) ? trim( (string) $about['id'] ) : '';
		return '' === $kind || '' === $id ? null : array(
			'kind' => $kind,
			'id'   => $id,
		);
	}

	/** One of the tool's own words for the call (`context.text`'s `title` or `summary`), or null. */
	private static function own_words( array $a, string $which ): ?string {
		$text = is_array( $a['context']['text'] ?? null ) ? $a['context']['text'] : array();
		$own  = is_string( $text[ $which ] ?? null ) ? trim( $text[ $which ] ) : '';
		return '' === $own ? null : $own;
	}

	/** A tool's id in words: its last part, `woo.refund-large` → "Refund large". */
	public static function tool_name( string $id ): string {
		$parts = explode( '.', $id );
		return self::words( (string) end( $parts ) );
	}

	/**
	 * A call's fields as label and value: `orderId` → "Order ID", a list
	 * or an object as its JSON, each cut short. Words someone wrote
	 * (`is_prose`) are left to `words_of`; ids only a machine reads
	 * (`is_reference`) are left out.
	 *
	 * @param mixed    $arguments The call's fields.
	 * @param string[] $shown     Fields the card shows elsewhere (a reply's `to`, in its heading).
	 * @return array<int, array{label: string, value: string}>
	 */
	public static function facts( $arguments, array $shown = array() ): array {
		$facts = array();
		foreach ( self::fields( $arguments ) as $key => $value ) {
			if ( ! in_array( $key, $shown, true ) && ! self::is_prose( $value ) && ! self::is_reference( (string) $key, $value ) ) {
				$facts[] = array(
					'label' => self::words( (string) $key ),
					'value' => self::text_of( $value ),
				);
			}
		}
		return $facts;
	}

	/**
	 * The whole call, when its facts and words leave part of it out: a
	 * field past the first `FACTS_MAX`, a value cut at `VALUE_MAX`, words
	 * cut at `WORDS_MAX`, or a call that's a list or a value rather than
	 * fields. Every field then, in order, each value whole; null when the
	 * card already shows all of it.
	 *
	 * @return array<int, array{label: string, value: string}>|null
	 */
	public static function whole( $arguments ): ?array {
		if ( null === $arguments || array() === $arguments ) {
			return null;
		}
		if ( array() === self::fields( $arguments ) ) {
			return array(
				array(
					'label' => __( 'The call', 'kindgi' ),
					'value' => self::plain( $arguments, true ),
				),
			);
		}
		$left_out = count( $arguments ) > self::FACTS_MAX;
		$rows     = array();
		foreach ( $arguments as $key => $value ) {
			$prose    = self::is_prose( $value );
			$text     = $prose ? trim( $value ) : self::plain( $value, true );
			// Measured as the card shows it: words whole up to `WORDS_MAX`, a value as `text_of` cuts it.
			$left_out = $left_out || mb_strlen( $prose ? $text : self::plain( $value ) ) > ( $prose ? self::WORDS_MAX : self::VALUE_MAX );
			$rows[]   = array(
				'label' => self::words( (string) $key ),
				'value' => $text,
			);
		}
		return $left_out ? $rows : null;
	}

	/**
	 * A call's fields that are words someone wrote, the agent that asked:
	 * a reason, a note to the customer. Shown as theirs, never as a fact.
	 *
	 * @param mixed                      $arguments The call's fields.
	 * @param array<string, string>|null $prose     Its `prose_of`, when the caller has it.
	 * @param array<string, string>      $labels    A field's label, when its name in words isn't it.
	 * @return array<int, array{label: string, text: string}>
	 */
	public static function words_of( $arguments, ?array $prose = null, array $labels = array() ): array {
		$words = array();
		foreach ( $prose ?? self::prose_of( $arguments ) as $key => $text ) {
			$words[] = array(
				'label' => $labels[ $key ] ?? self::words( (string) $key ),
				'text'  => self::cut( $text, self::WORDS_MAX ),
			);
		}
		return $words;
	}

	/**
	 * The call's fields that are someone's words (`is_prose`), whole, by name.
	 *
	 * @return array<string, string>
	 */
	private static function prose_of( $arguments ): array {
		$prose = array();
		foreach ( self::fields( $arguments ) as $key => $value ) {
			if ( self::is_prose( $value ) ) {
				$prose[ (string) $key ] = trim( $value );
			}
		}
		return $prose;
	}

	/**
	 * Whether a value reads as someone's words rather than a value: more
	 * than one line, a sentence of five words or more, or twelve words.
	 */
	public static function is_prose( $value ): bool {
		if ( ! is_string( $value ) ) {
			return false;
		}
		$text  = trim( $value );
		$count = preg_match_all( '/\S+/u', $text );
		return false !== strpos( $text, "\n" ) || $count >= 12 || ( $count >= 5 && 1 === preg_match( '/[.!?…]$/u', $text ) );
	}

	/**
	 * Whether a field is an id only a machine reads: its name says it's an
	 * id (`id`, `inReplyTo`, or one ending `Id`, `ID` or `_id`: `messageId`,
	 * `customer_id`), and its value is one: a UUID, a hex string, or a long
	 * run of letters and digits (a mail's id at Gmail or Outlook). No one
	 * deciding can check it, so the card leaves it out of the facts. Both
	 * must hold: an account number, an address or a code someone reads
	 * looks like an id, and its field doesn't say it is one.
	 */
	public static function is_reference( string $key, $value ): bool {
		if ( ! is_string( $value ) || 1 !== preg_match( '/^(?:id|inReplyTo)$|(?:Id|ID|_id)$/', $key ) ) {
			return false;
		}
		$text = trim( $value );
		return 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $text )
			|| 1 === preg_match( '/^(?=.*[0-9])(?=.*[a-f])[0-9a-f]{12,}$/i', $text )
			|| 1 === preg_match( '/^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9+\/=_-]{24,}$/', $text );
	}

	/**
	 * Whom a call's reply goes to, when it's a mail tool's reply
	 * (`gmailReply`, `outlookReply`: `inReplyTo`, the mail it answers; `to`;
	 * and `body`, the reply); else null.
	 *
	 * @return array{to: string}|null
	 */
	public static function reply_of( $arguments ): ?array {
		$f = self::fields( $arguments );
		if ( ! is_string( $f['inReplyTo'] ?? null ) || ! is_string( $f['body'] ?? null ) || ! is_string( $f['to'] ?? null ) || false === strpos( $f['to'], '@' ) ) {
			return null;
		}
		return array( 'to' => trim( $f['to'] ) );
	}

	/** An object's first fields; a list (or nothing) has none to name. PHP 7.4 has no array_is_list(). */
	private static function fields( $arguments ): array {
		if ( ! is_array( $arguments ) || array_keys( $arguments ) === range( 0, count( $arguments ) - 1 ) ) {
			return array();
		}
		return array_slice( $arguments, 0, self::FACTS_MAX, true );
	}

	/** A field's name in words, as a label. */
	public static function words( string $name ): string {
		$words = strtolower( trim( (string) preg_replace( '/[\s_-]+/', ' ', (string) preg_replace( '/([a-z0-9])([A-Z])/', '$1 $2', $name ) ) ) );
		$words = (string) preg_replace( array( '/\bid\b/', '/\burl\b/' ), array( 'ID', 'URL' ), $words );
		return '' === $words ? $name : ucfirst( $words );
	}

	/** A value as text, cut short (`plain`). */
	public static function text_of( $value ): string {
		return self::cut( self::plain( $value ) );
	}

	/**
	 * A value as text, whole: a list of words or numbers joined, anything
	 * else as its JSON, laid out over lines when `$lines` (the whole call).
	 */
	private static function plain( $value, bool $lines = false ): string {
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
			$text = (string) wp_json_encode( $value, $lines ? JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE : 0 );
		}
		return $text;
	}

	/** A text cut to `$max` characters (`VALUE_MAX` unless said), the last an ellipsis. */
	private static function cut( string $text, int $max = self::VALUE_MAX ): string {
		return mb_strlen( $text ) > $max ? mb_substr( $text, 0, $max - 1 ) . '…' : $text;
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

	/**
	 * How many on a page of Kindgi's waiting approvals wait for the person,
	 * whether more pages may hold more (then it shows as "12+"), and the
	 * WooCommerce orders some are about: `you` when one about the order
	 * waits for the person, else `others` (the Orders list's column).
	 *
	 * @param array      $page     Kindgi's list: `data` and `hasMore`.
	 * @param string     $me       The person's Kindgi id.
	 * @param array|null $reviewer The person as a reviewer (`reviewer_of`).
	 * @return array{n: int, more: bool, orders: array<string, string>}
	 */
	public static function count_of( array $page, string $me, ?array $reviewer ): array {
		$n      = 0;
		$orders = array();
		foreach ( is_array( $page['data'] ?? null ) ? $page['data'] : array() as $a ) {
			if ( ! is_array( $a ) || ! in_array( $a['status'] ?? null, self::WAITING, true ) ) {
				continue;
			}
			$yours = null === self::not_yours( $a, $me, $reviewer );
			if ( $yours ) {
				++$n;
			}
			$order = Kindgi_Order::of( self::about_of( $a ) );
			if ( null !== $order && 'you' !== ( $orders[ (string) $order ] ?? null ) ) {
				$orders[ (string) $order ] = $yours ? 'you' : 'others';
			}
		}
		return array(
			'n'      => $n,
			'more'   => null !== $reviewer && true === ( $page['hasMore'] ?? false ),
			'orders' => $orders,
		);
	}

	/**
	 * The count kept for the person, or null when there's none to show.
	 *
	 * @return array{n: int, more: bool, orders: array<string, string>}|null
	 */
	public static function kept_count( int $user_id ): ?array {
		$kept = self::kept( $user_id );
		return null !== $kept && $kept['n'] >= 0 ? $kept : null;
	}

	/**
	 * Keeps the person's count for the minute: null keeps that Kindgi
	 * didn't answer, so it isn't asked again until the minute is out.
	 *
	 * @param array{n: int, more: bool, orders: array<string, string>}|null $count
	 */
	public static function keep_count( int $user_id, ?array $count ): void {
		$kept = null === $count ? array(
			'n'      => -1,
			'more'   => false,
			'orders' => array(),
		) : $count;
		set_transient( self::COUNT . $user_id, $kept, self::COUNT_TTL );
	}

	/** Forgets the person's count: the next heartbeat asks Kindgi again. */
	public static function forget_count( int $user_id ): void {
		delete_transient( self::COUNT . $user_id );
	}

	/**
	 * How many approvals wait for the person to decide, asked of Kindgi at
	 * most once a minute, and only on a session the person still has: a
	 * page load never signs anyone in, so it never makes anyone a person
	 * at Kindgi or sends their name again. Null when there's nothing to
	 * show (not connected, no live session, or Kindgi didn't answer; a
	 * failure is kept for the minute too).
	 *
	 * @return array{n: int, more: bool, orders: array<string, string>}|null
	 */
	public static function count( WP_User $user ): ?array {
		$kept = self::kept( $user->ID );
		if ( null !== $kept ) {
			return $kept['n'] >= 0 ? $kept : null;
		}
		if ( null === Kindgi_Settings::site() || null === Kindgi_Sessions::kept( $user->ID ) ) {
			return null;
		}
		$count = self::ask_count( $user );
		self::keep_count( $user->ID, $count );
		return $count;
	}

	/**
	 * The count as kept, a failure (`n` -1) included; null when there's none.
	 *
	 * @return array{n: int, more: bool, orders: array<string, string>}|null
	 */
	private static function kept( int $user_id ): ?array {
		$kept = get_transient( self::COUNT . $user_id );
		return is_array( $kept ) && is_int( $kept['n'] ?? null ) && is_bool( $kept['more'] ?? null ) && is_array( $kept['orders'] ?? null ) ? $kept : null;
	}

	/**
	 * Someone who can't decide is asked for the page only when they see the
	 * Orders list's column, which says which orders wait for a reviewer.
	 * The count is the current user's (the heartbeat's), as `shown` reads.
	 *
	 * @return array{n: int, more: bool, orders: array<string, string>}|null
	 */
	private static function ask_count( WP_User $user ): ?array {
		$permissions = Kindgi_Api::kept_get( $user, '/v1/identity/me/permissions' );
		if ( ! is_array( $permissions ) ) {
			return null;
		}
		$reviewer = self::reviewer_of( $permissions['body'] );
		if ( null === $reviewer && ! Kindgi_Order::shown() ) {
			return array(
				'n'      => 0,
				'more'   => false,
				'orders' => array(),
			);
		}
		$page = Kindgi_Api::kept_get(
			$user,
			'/v1/approvals',
			array(
				'scopeKind' => 'project',
				'scopeId'   => $permissions['session']['project_id'],
				'status'    => implode( ',', self::WAITING ),
				'limit'     => self::COUNT_PAGE,
			)
		);
		return is_array( $page ) ? self::count_of( $page['body'], (string) $page['session']['user_id'], $reviewer ) : null;
	}

	/**
	 * WordPress's heartbeat on an admin page asks for the count; it answers
	 * with it, or null. The orders that wait go only to someone who sees
	 * the Orders list's column.
	 */
	public static function heartbeat( array $response, array $data ): array {
		if ( empty( $data['kindgi_inbox'] ) || ! Kindgi_Rest::allowed() ) {
			return $response;
		}
		$count = self::count( wp_get_current_user() );
		if ( null !== $count && ! Kindgi_Order::shown() ) {
			$count['orders'] = array();
		}
		$response['kindgi_inbox'] = $count;
		return $response;
	}
}
