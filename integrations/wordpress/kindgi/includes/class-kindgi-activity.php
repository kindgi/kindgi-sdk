<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Activity: what the project's agents and flows did, newest first, whoever
 * or whatever started it: a person here, someone at Kindgi, a webhook, a
 * schedule. Each run is one row in words; its output is a click away.
 */
final class Kindgi_Activity {

	/** A row's summary: at most this many of an output's fields, and this many characters. */
	const SUMMARY_FIELDS = 3;
	const SUMMARY_MAX    = 200;

	/** The whole output, behind a click, is cut to this many characters. */
	const OUTPUT_MAX = 4000;

	/** How a run starts when no person starts it: a key, or a trigger. */
	const UNATTENDED = array( 'webhook', 'schedule', 'event', 'mail', 'key' );

	/** An output's fields that hold its answer in words, in the order they're looked for. */
	const TEXT_FIELDS = array( 'summary', 'text', 'message', 'reply', 'answer' );

	/**
	 * A run as its row. The person's own runs show whole, with their
	 * conversation. Someone else's is theirs: one line, who, which agent,
	 * when and its state. A run no person started shows what it found, on
	 * a store only to someone who can edit orders: what a store's webhooks
	 * and schedules start is about its orders, and a run doesn't say which.
	 *
	 * @param array    $run          Kindgi's run.
	 * @param string   $me           The person's Kindgi id.
	 * @param callable $who          `user:<id>` to a name on this site, or null for someone it didn't sign in.
	 * @param bool     $reads_orders Whether the person may read the store's orders (or it's no store).
	 */
	public static function row( array $run, string $me, callable $who, bool $reads_orders ): array {
		$agent   = is_array( $run['agent'] ?? null ) ? $run['agent'] : array();
		$trigger = is_array( $run['trigger'] ?? null ) ? $run['trigger'] : array();
		$started = self::started_by( $run, $me, $who );
		$mine    = 'you' === $started['kind'];
		// Why what it found doesn't show: someone else's run, or the store's orders.
		$private = null;
		if ( ! $mine ) {
			$private = in_array( $started['kind'], self::UNATTENDED, true ) ? ( $reads_orders ? null : 'orders' ) : 'someone-else';
		}
		$output = null === $private ? ( $run['output'] ?? null ) : null;
		return array(
			'id'             => (string) ( $run['id'] ?? '' ),
			'status'         => (string) ( $run['status'] ?? '' ),
			'createdAt'      => (string) ( $run['createdAt'] ?? '' ),
			'completedAt'    => is_string( $run['completedAt'] ?? null ) ? $run['completedAt'] : null,
			// An agent's run names the agent (the page has their names); a flow's, the flow.
			'agentId'        => is_string( $agent['id'] ?? null ) ? $agent['id'] : null,
			'flow'           => is_string( $run['flowId'] ?? null ) ? Kindgi_Inbox::tool_name( $run['flowId'] ) : null,
			// Only the person's own: a conversation is its participant's.
			'conversationId' => $mine && is_string( $agent['conversationId'] ?? null ) ? $agent['conversationId'] : null,
			'startedBy'      => $started,
			'triggerKind'    => is_string( $trigger['kind'] ?? null ) ? $trigger['kind'] : null,
			'summary'        => self::summary( $output ),
			'output'         => self::output( $output ),
			'failureMessage' => null === $private && is_string( $run['failureMessage'] ?? null ) ? $run['failureMessage'] : null,
			'private'        => $private,
			'waiting'        => is_array( $run['waitingFor']['approvals'] ?? null ) && array() !== $run['waitingFor']['approvals'],
		);
	}

	/**
	 * Who or what started the run: `you`, a `person` on this site, someone
	 * at `kindgi` this site didn't sign in, or how it started without one
	 * (`webhook`, `schedule`, `event`, `mail`, `key`, or `unknown`).
	 *
	 * @return array{kind: string, name: string|null}
	 */
	public static function started_by( array $run, string $me, callable $who ): array {
		$how = is_string( $run['startedBy'] ?? null ) ? $run['startedBy'] : 'unknown';
		if ( 'person' !== $how ) {
			return array(
				'kind' => in_array( $how, self::UNATTENDED, true ) ? $how : 'unknown',
				'name' => null,
			);
		}
		return Kindgi_Inbox::asked( is_string( $run['actsFor'] ?? null ) ? $run['actsFor'] : null, $me, $who );
	}

	/**
	 * The run's output as text, cut short, or null for none: an agent's
	 * turn as its answer, anything else as indented JSON.
	 */
	public static function output( $output ): ?string {
		if ( null === $output ) {
			return null;
		}
		$answer = self::answer( $output );
		if ( null !== $answer ) {
			$text = $answer;
		} else {
			$text = is_string( $output ) ? $output : (string) wp_json_encode( $output, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		}
		return mb_strlen( $text ) > self::OUTPUT_MAX ? mb_substr( $text, 0, self::OUTPUT_MAX - 1 ) . '…' : $text;
	}

	/** An agent's turn's answer: the words of the message it ended with, or null. */
	public static function answer( $output ): ?string {
		$content = is_array( $output ) && is_array( $output['response'] ?? null ) ? ( $output['response']['content'] ?? null ) : null;
		return is_string( $content ) && '' !== trim( $content ) ? $content : null;
	}

	/**
	 * What a run's output says in words, when it says any: its text, a
	 * text field's, an agent's answer, or the first field that holds words.
	 */
	public static function said( $output ): ?string {
		if ( is_string( $output ) ) {
			return '' !== trim( $output ) ? $output : null;
		}
		return is_array( $output ) ? ( self::words_in( $output ) ?? self::answer( $output ) ) : null;
	}

	/**
	 * A run's output in one line: what it says (`said`), else its first
	 * few fields as "Label value", else nothing.
	 */
	public static function summary( $output ): ?string {
		$text = self::said( $output );
		if ( null === $text && is_array( $output ) ) {
			$parts = array();
			foreach ( array_slice( Kindgi_Inbox::facts( $output ), 0, self::SUMMARY_FIELDS ) as $fact ) {
				$parts[] = $fact['label'] . ' ' . $fact['value'];
			}
			$text = array() === $parts ? null : implode( ' · ', $parts );
		}
		$text = null === $text ? '' : trim( $text );
		if ( '' === $text ) {
			return null;
		}
		// One line of plain words: Markdown's bold and code marks left out.
		$line = trim( str_replace( array( '**', '`' ), '', explode( "\n", $text, 2 )[0] ) );
		return mb_strlen( $line ) > self::SUMMARY_MAX ? mb_substr( $line, 0, self::SUMMARY_MAX - 1 ) . '…' : $line;
	}

	/** An output's words: a text field's, else the first field that holds a sentence. */
	private static function words_in( array $output ): ?string {
		foreach ( self::TEXT_FIELDS as $field ) {
			if ( is_string( $output[ $field ] ?? null ) && '' !== trim( $output[ $field ] ) ) {
				return $output[ $field ];
			}
		}
		foreach ( $output as $value ) {
			if ( is_string( $value ) && 1 === preg_match( '/\S\s+\S/', trim( $value ) ) ) {
				return $value;
			}
		}
		return null;
	}
}
