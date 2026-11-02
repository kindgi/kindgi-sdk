<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Mail that started an agent's turn, read back for people. When mail
 * starts a run, the agent is given the thread as text (`mailTurn`, in
 * `@kindgi/connections`): its subject, then each mail with who it's from,
 * when, and its text. The conversation keeps that text as the turn's
 * message; this reads it back as the thread and its mails, so a person
 * sees an email where the agent saw its text. A text that isn't one reads
 * as null, and shows as written.
 */
final class Kindgi_Mail {

	/** The text's first line: the thread's subject, then how many mails it has and shows. */
	const THREAD = '/^Mail thread "(.*)": \d+ (?:new )?mails?, \d+ shown, oldest first$/';

	/** Mails the text leaves out, for its length: a line of their own. */
	const LEFT_OUT = '/^--- (\d+) mails? left out ---$/';

	/**
	 * A mail's first line: `NEW` and its id for the new mail, its id for an
	 * earlier one with attachments; then who it's from, when it came, and
	 * its subject when it isn't the thread's.
	 */
	const MAIL = '/^--- (NEW, )?(?:id (\S+): )?(.*?)(?:, (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC)?(?:, subject "(.*)")?$/';

	/** The new mail's To, Cc and Reply-To, on the line after its first, the parts apart by " · ". */
	const RECIPIENTS = '/^(?:To|Cc|Reply-To): /';

	/** The last lines a mail's text can end with. */
	const CUT         = '[the rest of this mail is cut]';
	const ATTACHMENTS = 'Attachments: ';
	const NO_TEXT     = '(no text)';

	/** What follows the sender: the mailbox's sent mail, or mail that only bears its address. */
	const SENT      = ' (this mailbox)';
	const NOT_SENT  = " (this mailbox's address, not its sent mail)";
	const NO_SENDER = '(no sender)';

	/**
	 * The thread a turn's text gives, or null when the text isn't one.
	 *
	 * @return array{subject: string, leftOut: int, mails: array<int, array>}|null
	 */
	public static function thread_of( string $text ): ?array {
		$lines = preg_split( '/\r\n|\n/', $text );
		if ( false === $lines || 1 !== preg_match( self::THREAD, $lines[0], $m ) ) {
			return null;
		}
		$thread = array(
			'subject' => $m[1],
			'leftOut' => 0,
			'mails'   => array(),
		);
		$head   = null;
		$body   = array();
		foreach ( array_slice( $lines, 1 ) as $line ) {
			$left_out = 1 === preg_match( self::LEFT_OUT, $line, $count );
			$next     = ! $left_out && 1 === preg_match( self::MAIL, $line, $parts );
			if ( ! $left_out && ! $next ) {
				if ( null === $head ) {
					// Text before the first mail: not a turn `mailTurn` wrote.
					return null;
				}
				$body[] = $line;
				continue;
			}
			// A line that starts `---` ends the mail before it: a mail's own such lines are set in by a space.
			$thread['mails']    = self::add( $thread['mails'], $head, $body );
			$thread['leftOut'] += $left_out ? (int) $count[1] : 0;
			$head               = $next ? $parts : null;
			$body               = array();
		}
		$thread['mails'] = self::add( $thread['mails'], $head, $body );
		return array() === $thread['mails'] ? null : $thread;
	}

	/** The mails so far, with the one whose lines were just read, when there is one. */
	private static function add( array $mails, ?array $head, array $body ): array {
		if ( null !== $head ) {
			$mails[] = self::mail( $head, $body );
		}
		return $mails;
	}

	/**
	 * One mail, from its first line's parts (`MAIL`) and its other lines:
	 * the new mail's recipients, its text, and how its text ends.
	 */
	private static function mail( array $head, array $lines ): array {
		$new        = '' !== ( $head[1] ?? '' );
		$recipients = array();
		if ( $new && array() !== $lines && 1 === preg_match( self::RECIPIENTS, $lines[0] ) ) {
			foreach ( explode( ' · ', array_shift( $lines ) ) as $part ) {
				$at           = strpos( $part, ': ' );
				$recipients[] = array(
					'kind' => false === $at ? '' : substr( $part, 0, $at ),
					'who'  => false === $at ? $part : substr( $part, $at + 2 ),
				);
			}
		}
		// An earlier mail names its id only when it lists attachments; the new mail always does.
		$attachments = null;
		$last        = end( $lines );
		if ( ( $new || '' !== ( $head[2] ?? '' ) ) && is_string( $last ) && 0 === strpos( $last, self::ATTACHMENTS ) ) {
			$attachments = substr( array_pop( $lines ), strlen( self::ATTACHMENTS ) );
		}
		$cut = self::CUT === end( $lines );
		if ( $cut ) {
			array_pop( $lines );
		}
		$text = rtrim( implode( "\n", array_map( array( self::class, 'unset_line' ), $lines ) ) );
		return array(
			'new'         => $new,
			'from'        => self::from( $head[3] ?? '' ),
			'at'          => '' !== ( $head[4] ?? '' ) ? str_replace( ' ', 'T', $head[4] ) . ':00Z' : null,
			'subject'     => isset( $head[5] ) && '' !== $head[5] ? $head[5] : null,
			'recipients'  => $recipients,
			'text'        => self::NO_TEXT === $text ? '' : $text,
			'cut'         => $cut,
			'attachments' => $attachments,
		);
	}

	/**
	 * Who a mail is from: a name and an address, `mine` when it's the
	 * mailbox's own sent mail, or `unsure` when it only bears the mailbox's
	 * address (anyone can send mail from an address).
	 *
	 * @return array{name: string|null, address: string|null, mine: bool, unsure: bool}
	 */
	public static function from( string $text ): array {
		$unsure = self::ends( $text, self::NOT_SENT );
		$mine   = ! $unsure && self::ends( $text, self::SENT );
		if ( $unsure || $mine ) {
			$text = substr( $text, 0, -strlen( $unsure ? self::NOT_SENT : self::SENT ) );
		}
		if ( self::NO_SENDER === $text ) {
			return array(
				'name'    => null,
				'address' => null,
				'mine'    => false,
				'unsure'  => false,
			);
		}
		$person = 1 === preg_match( '/^(.*) <([^<>]*)>$/', $text, $m );
		return array(
			'name'    => $person ? $m[1] : null,
			'address' => $person ? $m[2] : $text,
			'mine'    => $mine,
			'unsure'  => $unsure,
		);
	}

	/** Whether a text ends with another: PHP 7.4 has no str_ends_with(). */
	private static function ends( string $text, string $end ): bool {
		return strlen( $text ) >= strlen( $end ) && substr( $text, -strlen( $end ) ) === $end;
	}

	/**
	 * A line of a mail's own text as it was: `mailTurn` sets in by a space
	 * each that would read as one of its own `---` lines.
	 */
	private static function unset_line( string $line ): string {
		return 1 === preg_match( '/^ \p{Cf}*---/u', $line ) ? substr( $line, 1 ) : $line;
	}
}
