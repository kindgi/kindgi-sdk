<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * The Kindgi page's own routes on the store (`/wp-json/kindgi/v1/…`): each
 * needs the WordPress login (cookie and `X-WP-Nonce`) and the page's
 * capability, then makes one fixed call to Kindgi as the signed-in person.
 * Nothing here forwards a path or a body the browser chose.
 */
final class Kindgi_Rest {

	const ROUTE_NAMESPACE = 'kindgi/v1';

	/** An id as Kindgi makes them: a UUID or a slug. */
	const ID = '[A-Za-z0-9._:-]{1,128}';

	/** A message's most characters. */
	const MESSAGE_MAX = 20000;

	/** A reason's most characters. */
	const REASON_MAX = 2000;

	/** A conversation shows its newest this many messages. */
	const MESSAGES_SHOWN = 100;

	/** At most this many pages of messages are read to reach the newest. */
	const MESSAGES_PAGES_MAX = 50;

	/** Kindgi's subject kind for a tool call waiting for a person. */
	const TOOL_CALL = 'tool-call:pending';

	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'routes' ) );
	}

	public static function routes(): void {
		$id = '(?P<id>' . self::ID . ')';
		self::route( '/me', 'GET', 'me' );
		self::route( '/agents', 'GET', 'agents' );
		self::route( '/conversations', 'GET', 'conversations', array( 'cursor' => self::optional_string( 512 ) ) );
		self::route(
			'/conversations',
			'POST',
			'open_conversation',
			array(
				'agentId'      => self::required_string( 128 ),
				'agentVersion' => self::required_string( 64 ),
				'title'        => self::optional_string( 200 ),
			)
		);
		self::route( '/conversations/' . $id . '/messages', 'GET', 'messages' );
		self::route( '/conversations/' . $id . '/turns', 'POST', 'turn', array( 'message' => self::required_string( self::MESSAGE_MAX ) ) );
		self::route(
			'/runs/' . $id,
			'GET',
			'run',
			array(
				'since' => array(
					'type'    => 'integer',
					'minimum' => 0,
					'default' => 0,
				),
			)
		);
		self::route(
			'/approvals',
			'GET',
			'approvals',
			array(
				'view' => array(
					'type'    => 'string',
					'enum'    => array( 'waiting', 'decided' ),
					'default' => 'waiting',
				),
			)
		);
		self::route( '/approvals/' . $id, 'GET', 'approval' );
		self::route(
			'/approvals/' . $id . '/decide',
			'POST',
			'decide',
			array(
				'decision' => array(
					'type'     => 'string',
					'enum'     => array( 'approve', 'reject' ),
					'required' => true,
				),
				'reason'   => self::optional_string( self::REASON_MAX ),
			)
		);
	}

	/** Who may use the page and its routes. */
	public static function allowed(): bool {
		return current_user_can( Kindgi_Admin::capability() );
	}

	/** The person, their Kindgi id, and whether they review approvals. */
	public static function me() {
		$who = Kindgi_Api::body( wp_get_current_user(), 'GET', '/v1/identity/whoami' );
		if ( is_wp_error( $who ) ) {
			return $who;
		}
		return array(
			'userId'       => $who['session']['user_id'],
			'projectId'    => $who['session']['project_id'],
			'reviewerRole' => is_string( $who['body']['reviewerRole'] ?? null ) ? $who['body']['reviewerRole'] : null,
			'name'         => wp_get_current_user()->display_name,
		);
	}

	/** The project's agents the person can see. */
	public static function agents() {
		$user    = wp_get_current_user();
		$project = self::project( $user );
		if ( is_wp_error( $project ) ) {
			return $project;
		}
		$answer = Kindgi_Api::body(
			$user,
			'GET',
			'/v1/agents',
			array(
				'scopeKind' => 'project',
				'scopeId'   => $project,
				'limit'     => 100,
			)
		);
		if ( is_wp_error( $answer ) ) {
			return $answer;
		}
		$agents = array();
		foreach ( self::list_of( $answer['body']['data'] ?? null ) as $agent ) {
			$agents[] = array(
				'id'          => (string) ( $agent['id'] ?? '' ),
				'version'     => (string) ( $agent['version'] ?? '' ),
				'name'        => (string) ( $agent['name'] ?? $agent['id'] ?? '' ),
				'description' => is_string( $agent['description'] ?? null ) ? $agent['description'] : '',
			);
		}
		return array( 'agents' => $agents );
	}

	/** The conversations this person opened, newest first. */
	public static function conversations( WP_REST_Request $request ) {
		$user    = wp_get_current_user();
		$project = self::project( $user );
		if ( is_wp_error( $project ) ) {
			return $project;
		}
		$query = array(
			'scopeKind' => 'project',
			'scopeId'   => $project,
			'openedBy'  => 'me',
			'limit'     => 25,
		);
		if ( null !== $request['cursor'] && '' !== $request['cursor'] ) {
			$query['cursor'] = $request['cursor'];
		}
		$answer = Kindgi_Api::body( $user, 'GET', '/v1/conversations', $query );
		if ( is_wp_error( $answer ) ) {
			return $answer;
		}
		$conversations = array();
		foreach ( self::list_of( $answer['body']['data'] ?? null ) as $c ) {
			$conversations[] = self::conversation( $c );
		}
		return array(
			'conversations' => $conversations,
			'nextCursor'     => is_string( $answer['body']['nextCursor'] ?? null ) ? $answer['body']['nextCursor'] : null,
		);
	}

	/** A new conversation with one of the project's agents, as this person. */
	public static function open_conversation( WP_REST_Request $request ) {
		$user    = wp_get_current_user();
		$session = Kindgi_Sessions::for_user( $user );
		if ( is_wp_error( $session ) ) {
			return $session;
		}
		$agent = Kindgi_Api::body( $user, 'GET', '/v1/agents/' . rawurlencode( (string) $request['agentId'] ) . '/versions/' . rawurlencode( (string) $request['agentVersion'] ) );
		if ( is_wp_error( $agent ) ) {
			return $agent;
		}
		$open = array(
			'agentId'       => $request['agentId'],
			'agentVersion'  => $request['agentVersion'],
			// Memory kept per person: this person, whoever opens the page.
			'participantId' => $session['user_id'],
			'title'         => '' !== trim( (string) $request['title'] ) ? trim( (string) $request['title'] ) : __( 'From WordPress', 'kindgi' ),
		);
		$named = self::named_project( $session['project_id'], $agent['body']['projectId'] ?? null );
		if ( null !== $named ) {
			$open['projectId'] = $named;
		}
		$answer = Kindgi_Api::body( $user, 'POST', '/v1/conversations', array(), $open );
		return is_wp_error( $answer ) ? $answer : self::conversation( $answer['body'] );
	}

	/**
	 * A conversation's newest messages, oldest first. Kindgi pages them
	 * oldest first, so the pages are read through to the newest; `earlier`
	 * says some older ones aren't shown.
	 */
	public static function messages( WP_REST_Request $request ) {
		$path  = '/v1/conversations/' . rawurlencode( $request['id'] ) . '/messages';
		$pages = self::newest_messages(
			static function ( ?string $cursor ) use ( $path ) {
				$query = array( 'limit' => self::MESSAGES_SHOWN );
				if ( null !== $cursor ) {
					$query['cursor'] = $cursor;
				}
				$answer = Kindgi_Api::body( wp_get_current_user(), 'GET', $path, $query );
				return is_wp_error( $answer ) ? $answer : $answer['body'];
			}
		);
		if ( is_wp_error( $pages ) ) {
			return $pages;
		}
		$rows = $pages['rows'];
		$messages = array();
		foreach ( $rows as $m ) {
			$content = $m['content'] ?? null;
			$text    = is_string( $content ) ? $content : ( is_string( $content['text'] ?? null ) ? $content['text'] : '' );
			$calls   = array();
			foreach ( self::list_of( is_array( $content ) ? ( $content['toolCalls'] ?? null ) : null ) as $call ) {
				if ( is_string( $call['name'] ?? null ) ) {
					$calls[] = $call['name'];
				}
			}
			$messages[] = array(
				'sequence'  => (int) ( $m['sequence'] ?? 0 ),
				'role'      => (string) ( $m['role'] ?? '' ),
				// An agent's words, or '' when its message only calls tools.
				'text'      => 'tool' === ( $m['role'] ?? '' ) ? '' : $text,
				// The tools an agent's message calls.
				'calls'     => $calls,
				// A tool's answer: which tool, and what it returned.
				'toolId'    => is_string( $m['toolCall']['toolId'] ?? null ) ? $m['toolCall']['toolId'] : null,
				'result'    => 'tool' === ( $m['role'] ?? '' ) ? $content : null,
				'createdAt' => (string) ( $m['createdAt'] ?? '' ),
			);
		}
		return array(
			'messages' => $messages,
			'earlier'  => $pages['earlier'],
		);
	}

	/**
	 * Reads a conversation's pages (oldest first) through to the newest,
	 * at most `MESSAGES_PAGES_MAX` of them, keeping the newest
	 * `MESSAGES_SHOWN` messages.
	 *
	 * @param callable $fetch One page by cursor (null for the first): Kindgi's body, or a WP_Error.
	 * @return array{rows: array, earlier: bool}|WP_Error
	 */
	public static function newest_messages( callable $fetch ) {
		$rows   = array();
		$seen   = 0;
		$cursor = null;
		$pages  = 0;
		do {
			$body = $fetch( $cursor );
			if ( is_wp_error( $body ) ) {
				return $body;
			}
			$page   = self::list_of( $body['data'] ?? null );
			$seen  += count( $page );
			$rows   = array_slice( array_merge( $rows, $page ), -self::MESSAGES_SHOWN );
			$cursor = true === ( $body['hasMore'] ?? false ) && is_string( $body['nextCursor'] ?? null ) ? $body['nextCursor'] : null;
			++$pages;
		} while ( null !== $cursor && $pages < self::MESSAGES_PAGES_MAX );
		return array(
			'rows'    => $rows,
			'earlier' => $seen > count( $rows ) || null !== $cursor,
		);
	}

	/** A turn: the person's message to the conversation's agent, started and followed by polling. */
	public static function turn( WP_REST_Request $request ) {
		$user         = wp_get_current_user();
		$conversation = Kindgi_Api::body( $user, 'GET', '/v1/conversations/' . rawurlencode( $request['id'] ) );
		if ( is_wp_error( $conversation ) ) {
			return $conversation;
		}
		$c = $conversation['body'];
		// A turn runs as the conversation's participant, with that person's memory: only theirs.
		if ( ! self::owns( $c, (string) $conversation['session']['user_id'] ) ) {
			return new WP_Error( 'kindgi_conversation_not_found', __( 'No conversation of yours has that id.', 'kindgi' ), array( 'status' => 404 ) );
		}
		$answer = Kindgi_Api::body(
			$user,
			'POST',
			'/v1/runs',
			array(),
			array(
				'agent'        => (string) ( $c['agentId'] ?? '' ),
				'agentVersion' => (string) ( $c['agentVersion'] ?? '' ),
				'input'        => array(
					'userMessage'    => $request['message'],
					'conversationId' => $request['id'],
				),
				'options'      => array( 'wait' => false ),
			)
		);
		if ( is_wp_error( $answer ) ) {
			return $answer;
		}
		return array(
			'runId'  => (string) ( $answer['body']['id'] ?? '' ),
			'status' => (string) ( $answer['body']['status'] ?? '' ),
		);
	}

	/** A turn's state: its status, its steps since `since`, and what it waits for. */
	public static function run( WP_REST_Request $request ) {
		$user = wp_get_current_user();
		$path = '/v1/runs/' . rawurlencode( $request['id'] );
		$run  = Kindgi_Api::body( $user, 'GET', $path );
		if ( is_wp_error( $run ) ) {
			return $run;
		}
		$journal = Kindgi_Api::body( $user, 'GET', $path . '/journal', array( 'since' => (int) $request['since'] ) );
		if ( is_wp_error( $journal ) ) {
			return $journal;
		}
		// The tools the agent called, by name: nothing else of the journal reaches the browser.
		// `since` is exclusive: the next poll asks for what came after the last entry seen.
		$steps = array();
		$last  = (int) $request['since'];
		foreach ( self::list_of( $journal['body']['data'] ?? null ) as $entry ) {
			$last = max( $last, (int) ( $entry['sequence'] ?? 0 ) );
			if ( 'step.completed' !== ( $entry['kind'] ?? '' ) ) {
				continue;
			}
			foreach ( self::list_of( $entry['payload']['output']['message']['toolCalls'] ?? null ) as $call ) {
				if ( is_string( $call['name'] ?? null ) ) {
					$steps[] = array(
						'toolId' => $call['name'],
						'at'     => (string) ( $entry['timestamp'] ?? '' ),
					);
				}
			}
		}
		$r       = $run['body'];
		$waiting = array();
		foreach ( self::list_of( $r['waitingFor']['approvals'] ?? null ) as $a ) {
			$waiting[] = array(
				'approvalId'   => (string) ( $a['approvalId'] ?? '' ),
				'title'        => is_string( $a['title'] ?? null ) ? $a['title'] : '',
				'toolId'       => is_string( $a['tool']['id'] ?? null ) ? $a['tool']['id'] : null,
				'requiredRole' => (string) ( $a['requiredRole'] ?? '' ),
				'expiresAt'    => is_string( $a['expiresAt'] ?? null ) ? $a['expiresAt'] : null,
			);
		}
		return array(
			'id'             => (string) ( $r['id'] ?? '' ),
			'status'         => (string) ( $r['status'] ?? '' ),
			'conversationId' => is_string( $r['agent']['conversationId'] ?? null ) ? $r['agent']['conversationId'] : null,
			'failureMessage' => is_string( $r['failureMessage'] ?? null ) ? $r['failureMessage'] : null,
			'waitingFor'     => $waiting,
			'steps'          => $steps,
			'since'          => $last,
		);
	}

	/** What waits for this person (oldest first), or what they decided lately (newest first). */
	public static function approvals( WP_REST_Request $request ) {
		$user    = wp_get_current_user();
		$project = self::project( $user );
		if ( is_wp_error( $project ) ) {
			return $project;
		}
		$waiting = 'waiting' === $request['view'];
		$query   = array(
			'scopeKind' => 'project',
			'scopeId'   => $project,
			'status'    => $waiting ? 'pending' : 'approved,rejected',
			'order'     => $waiting ? 'asc' : 'desc',
			'limit'     => $waiting ? 50 : 20,
		);
		if ( ! $waiting ) {
			$query['decidedBy'] = 'me';
		}
		$answer = Kindgi_Api::body( $user, 'GET', '/v1/approvals', $query );
		if ( is_wp_error( $answer ) ) {
			return $answer;
		}
		$me    = (string) $answer['session']['user_id'];
		$cards = array();
		foreach ( self::list_of( $answer['body']['data'] ?? null ) as $a ) {
			$cards[] = self::card( $a, $me );
		}
		return array( 'approvals' => $cards );
	}

	/** One approval, as its card. */
	public static function approval( WP_REST_Request $request ) {
		$answer = Kindgi_Api::body( wp_get_current_user(), 'GET', '/v1/approvals/' . rawurlencode( $request['id'] ) );
		return is_wp_error( $answer ) ? $answer : self::card( $answer['body'], (string) $answer['session']['user_id'] );
	}

	/** Approve or reject, as this person; the run resumes in the same call. */
	public static function decide( WP_REST_Request $request ) {
		$reason = trim( (string) $request['reason'] );
		if ( 'reject' === $request['decision'] && '' === $reason ) {
			return new WP_Error( 'kindgi_reason_required', __( 'Say why you reject it: the agent and whoever asked read it.', 'kindgi' ), array( 'status' => 400 ) );
		}
		$body = array( 'decision' => $request['decision'] );
		if ( '' !== $reason ) {
			$body['rationale'] = $reason;
		}
		$answer = Kindgi_Api::body( wp_get_current_user(), 'POST', '/v1/approvals/' . rawurlencode( $request['id'] ) . '/complete', array(), $body );
		if ( is_wp_error( $answer ) ) {
			return $answer;
		}
		$b = $answer['body'];
		return array(
			'approval'          => self::card( is_array( $b['approval'] ?? null ) ? $b['approval'] : array(), (string) $answer['session']['user_id'] ),
			'waitpointResolved' => (bool) ( $b['waitpointResolved'] ?? false ),
			'runStatus'         => is_string( $b['runStatus'] ?? null ) ? $b['runStatus'] : null,
		);
	}

	/**
	 * An approval as the page shows it. Names come from WordPress, never
	 * Kindgi: someone this site didn't sign in shows as outside it.
	 */
	private static function card( array $a, string $me ): array {
		$ref      = is_array( $a['subjectRef'] ?? null ) ? $a['subjectRef'] : array();
		$is_tool  = self::TOOL_CALL === ( $a['subjectKind'] ?? '' );
		$decision = is_array( $a['decision'] ?? null ) ? $a['decision'] : null;
		$asked_by = is_string( $a['requestedBy'] ?? null ) ? $a['requestedBy'] : null;
		return array(
			'id'               => (string) ( $a['id'] ?? '' ),
			'title'            => (string) ( $a['title'] ?? '' ),
			'description'      => is_string( $a['description'] ?? null ) ? $a['description'] : '',
			'status'           => (string) ( $a['status'] ?? '' ),
			'requiredRole'     => (string) ( $a['requiredRole'] ?? '' ),
			'createdAt'        => (string) ( $a['createdAt'] ?? '' ),
			'expiresAt'        => is_string( $a['expiresAt'] ?? null ) ? $a['expiresAt'] : null,
			'tool'             => $is_tool && is_string( $ref['toolId'] ?? null )
				? array(
					'id'        => $ref['toolId'],
					'arguments' => $ref['arguments'] ?? null,
				)
				: null,
			'agentId'          => $is_tool && is_string( $ref['agentId'] ?? null ) ? $ref['agentId'] : null,
			'conversationId'   => $is_tool && is_string( $ref['conversationId'] ?? null ) ? $ref['conversationId'] : null,
			// Who asked, when Kindgi recorded it: a name on this site, or null for someone outside it.
			'askedByKnown'     => null !== $asked_by,
			'askedBy'          => self::who( $asked_by ),
			'askedByMe'        => 'user:' . $me === $asked_by,
			'separateApprover' => (bool) ( $a['separateApprover'] ?? false ),
			'decision'         => null === $decision ? null : array(
				'decision'  => (string) ( $decision['decision'] ?? '' ),
				'decidedAt' => (string) ( $decision['decidedAt'] ?? '' ),
				'reason'    => is_string( $decision['rationale'] ?? null ) ? $decision['rationale'] : null,
				'by'        => self::who( is_string( $decision['decidedBy'] ?? null ) ? $decision['decidedBy'] : null ),
			),
		);
	}

	/**
	 * Who `user:<id>` is on this site: their WordPress name, or null for
	 * someone this site didn't sign in (the page says "someone outside this
	 * site").
	 */
	private static function who( ?string $principal ): ?string {
		static $names = array();
		if ( null === $principal || 0 !== strpos( $principal, 'user:' ) ) {
			return null;
		}
		$id = substr( $principal, 5 );
		if ( ! array_key_exists( $id, $names ) ) {
			global $wpdb;
			$users        = get_users(
				array(
					'meta_key'   => $wpdb->get_blog_prefix() . Kindgi_Sessions::USER_ID,
					'meta_value' => $id,
					'number'     => 1,
					'fields'     => array( 'display_name' ),
				)
			);
			$names[ $id ] = isset( $users[0] ) ? (string) $users[0]->display_name : null;
		}
		return $names[ $id ];
	}

	/**
	 * The project a new conversation names, if any. Unnamed, Kindgi opens it
	 * in its agent's own project: for the site's own agents, that's the
	 * site's project, and naming it would need write there, which no one a
	 * site signs in has. An agent another project shares with the site's
	 * is opened in the site's project by name, where calling it is enough.
	 *
	 * @param string $site_project The site's project.
	 * @param mixed  $own          The agent's own project, as Kindgi gave it.
	 */
	public static function named_project( string $site_project, $own ): ?string {
		return is_string( $own ) && '' !== $own && $own !== $site_project ? $site_project : null;
	}

	/** Whether a conversation is the person's own: they're its participant. */
	public static function owns( array $conversation, string $user_id ): bool {
		return '' !== $user_id && ( $conversation['participantId'] ?? null ) === $user_id;
	}

	/** The site's project, from the person's session. */
	private static function project( WP_User $user ) {
		$session = Kindgi_Sessions::for_user( $user );
		return is_wp_error( $session ) ? $session : $session['project_id'];
	}

	private static function conversation( array $c ): array {
		return array(
			'id'            => (string) ( $c['id'] ?? '' ),
			'title'         => (string) ( $c['title'] ?? '' ),
			'agentId'       => (string) ( $c['agentId'] ?? '' ),
			'agentVersion'  => (string) ( $c['agentVersion'] ?? '' ),
			'status'        => (string) ( $c['status'] ?? '' ),
			'openedAt'      => (string) ( $c['openedAt'] ?? '' ),
			'lastMessageAt' => is_string( $c['lastMessageAt'] ?? null ) ? $c['lastMessageAt'] : null,
			'turnCount'     => (int) ( $c['turnCount'] ?? 0 ),
		);
	}

	/** The arrays in a list Kindgi answered; anything else is skipped. */
	private static function list_of( $value ): array {
		return is_array( $value ) ? array_values( array_filter( $value, 'is_array' ) ) : array();
	}

	private static function route( string $path, string $method, string $callback, array $args = array() ): void {
		register_rest_route(
			self::ROUTE_NAMESPACE,
			$path,
			array(
				'methods'             => $method,
				'callback'            => array( self::class, $callback ),
				'permission_callback' => array( self::class, 'allowed' ),
				'args'                => $args,
			)
		);
	}

	private static function required_string( int $max ): array {
		return array(
			'type'      => 'string',
			'required'  => true,
			'minLength' => 1,
			'maxLength' => $max,
		);
	}

	private static function optional_string( int $max ): array {
		return array(
			'type'      => 'string',
			'maxLength' => $max,
		);
	}
}
