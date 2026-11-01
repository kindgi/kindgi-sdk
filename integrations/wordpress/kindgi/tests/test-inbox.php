<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Names on this site, by `user:<id>`: only `user:u-anna` is one. */
function kindgi_test_names(): callable {
	return static function ( string $principal ): ?string {
		return 'user:u-anna' === $principal ? 'Anna' : null;
	};
}

/**
 * The person as a reviewer of the given role: their row on the roster is
 * `r-me`, never their user id `u-me`.
 */
function kindgi_test_reviewer( string $role = 'standard' ): array {
	$ladder = array( 'standard', 'senior', 'admin' );
	return array(
		'id'      => 'r-me',
		'role'    => $role,
		'decides' => array_slice( $ladder, 0, (int) array_search( $role, $ladder, true ) + 1 ),
	);
}

/** A tool call waiting for a person, as Kindgi lists it, with the given fields changed. */
function kindgi_test_approval( array $changes = array() ): array {
	return array_merge(
		array(
			'id'           => 'ap-1',
			'subjectKind'  => 'tool-call:pending',
			'subjectRef'   => array(
				'toolId'         => 'acme-desk.woo.refund-large',
				'agentId'        => 'acme-desk.store-agent',
				'conversationId' => 'c-1',
				'arguments'      => array(
					'orderId' => 18,
					'amount'  => 210,
					'reason'  => 'One of the two vases arrived broken.',
				),
			),
			'title'        => 'HITL review: acme-desk.woo.refund-large',
			'description'  => 'Tool call acme-desk.woo.refund-large awaiting reviewer approval before dispatch.',
			'status'       => 'pending',
			'requiredRole' => 'standard',
			'createdAt'    => '2026-11-01T05:40:00Z',
			'expiresAt'    => '2026-11-02T05:40:00Z',
			'requestedBy'  => 'user:u-agency',
		),
		$changes
	);
}

/*
 * Kindgi's own words for every tool call, its title ("Approve a call to
 * <tool>", or "HITL review: <tool>" from an older runtime) and its
 * description "Tool call <tool> awaiting reviewer approval before
 * dispatch.", are left out together, for the tool's own words when it
 * gives some (`context.text`).
 */
function test_inbox_a_tool_calls_card_reads_in_words_not_kindgis(): void {
	$card = Kindgi_Inbox::card( kindgi_test_approval(), 'u-me', kindgi_test_reviewer(), kindgi_test_names() );
	kindgi_assert_same( 'Refund large', $card['heading'], 'the tool in words, not "HITL review: …"' );
	kindgi_assert_same( '', $card['summary'], "Kindgi's words for every tool call are left out" );
	kindgi_assert_same(
		array(
			array(
				'label' => 'Order ID',
				'value' => '18',
			),
			array(
				'label' => 'Amount',
				'value' => '210',
			),
		),
		$card['facts'],
		'what would run, field by field'
	);
	kindgi_assert_same(
		array(
			array(
				'label' => 'Reason',
				'text'  => 'One of the two vases arrived broken.',
			),
		),
		$card['words'],
		"the agent's reason is its words, not a fact"
	);
	kindgi_assert_same( 'you', $card['waitsFor'], 'a standard reviewer decides it' );
	kindgi_assert_same( 'kindgi', $card['asked']['kind'], 'asked by someone this site never signed in' );
	kindgi_assert_same( 'acme-desk.woo.refund-large', $card['details']['toolId'], "Kindgi's ids stay, behind Details" );
	kindgi_assert_same( 'c-1', $card['conversationId'], 'its conversation' );
}

function test_inbox_the_tools_own_words_for_a_call_read_first(): void {
	$generic = kindgi_test_approval( array( 'title' => 'Approve a call to acme-desk.woo.refund-large' ) );
	kindgi_assert_same( 'Refund large', Kindgi_Inbox::heading( $generic, 'acme-desk.woo.refund-large' ), "Kindgi's title for every call: the tool's name in words" );
	kindgi_assert_same( 'Approve a call to a-friend', Kindgi_Inbox::heading( array( 'title' => 'Approve a call to a-friend' ), null ), 'no tool call: the title as it is' );
	$card = Kindgi_Inbox::card(
		kindgi_test_approval(
			array(
				'title'   => 'Approve a call to acme-desk.woo.refund-large',
				'context' => array(
					'text'  => array(
						'title'   => 'Large refund: 210 on order #18',
						'summary' => 'One of the two vases arrived broken.',
					),
					'about' => array(
						'kind' => 'woocommerce.order',
						'id'   => '18',
					),
				),
			)
		),
		'u-me',
		kindgi_test_reviewer(),
		kindgi_test_names()
	);
	kindgi_assert_same( 'Large refund: 210 on order #18', $card['heading'], "the tool's title, filled in" );
	kindgi_assert_same( '', $card['summary'], 'a summary that is the agent\'s reason shows once' );
	kindgi_assert_same( 'Reason', $card['words'][0]['label'], 'as its words, quoted and theirs' );
	$long = 'The customer wrote that both vases arrived broken. ' . str_repeat( 'The box was crushed on one side. ', 10 );
	$card = Kindgi_Inbox::card(
		kindgi_test_approval(
			array(
				'subjectRef' => array(
					'toolId'    => 'acme-desk.woo.refund-large',
					'arguments' => array( 'reason' => $long ),
				),
				'context'    => array( 'text' => array( 'summary' => $long ) ),
			)
		),
		'u-me',
		kindgi_test_reviewer(),
		kindgi_test_names()
	);
	kindgi_assert_same( '', $card['summary'], 'a long reason that is also the summary shows once: compared whole, before the quote is cut' );
	kindgi_assert_same( trim( $long ), $card['words'][0]['text'], 'the quote, whole: a draft is read in full' );
	$words = Kindgi_Inbox::words_of( array( 'body' => str_repeat( 'The box was crushed on one side. ', 200 ) ) );
	kindgi_assert_same( Kindgi_Inbox::WORDS_MAX, mb_strlen( $words[0]['text'] ), 'words past the most a card shows, cut' );
	$own = kindgi_test_approval(
		array(
			'context' => array(
				'text' => array(
					'title'   => 'Publish product #7',
					'summary' => 'Goes live on the shop now.',
				),
			),
		)
	);
	kindgi_assert_same( 'Goes live on the shop now.', Kindgi_Inbox::summary( $own ), "the tool's own summary" );
}

function test_inbox_a_title_a_tool_gives_is_the_heading(): void {
	$card = Kindgi_Inbox::card(
		kindgi_test_approval(
			array(
				'title'       => 'Refund 210 on order #18',
				'description' => 'The customer sent a photo of the broken vase.',
			)
		),
		'u-me',
		kindgi_test_reviewer(),
		kindgi_test_names()
	);
	kindgi_assert_same( 'Refund 210 on order #18', $card['heading'], 'the title' );
	kindgi_assert_same( 'The customer sent a photo of the broken vase.', $card['summary'], 'the description' );
	kindgi_assert_same( 3, count( $card['facts'] ) + count( $card['words'] ), 'the fields still show: a title can leave one out' );
}

function test_inbox_sorts_what_waits_for_you_from_what_waits_for_others(): void {
	$cases = array(
		'no reviewer role'                       => array( array(), null, 'not-a-reviewer' ),
		'a standard one'                         => array( array(), 'standard', null ),
		'needs senior, you are standard'         => array( array( 'requiredRole' => 'senior' ), 'standard', 'needs-senior' ),
		'needs senior, you are admin'            => array( array( 'requiredRole' => 'senior' ), 'admin', null ),
		'needs admin, you are senior'            => array( array( 'requiredRole' => 'admin' ), 'senior', 'needs-admin' ),
		'a required role Kindgi has no word for' => array( array( 'requiredRole' => 'owner' ), 'admin', 'needs-owner' ),
		'you asked, another decides'             => array(
			array(
				'requestedBy'      => 'user:u-me',
				'separateApprover' => true,
			),
			'standard',
			'you-asked',
		),
		'you asked, anyone decides'              => array( array( 'requestedBy' => 'user:u-me' ), 'standard', null ),
		'assigned to another reviewer'           => array( array( 'assignedTo' => 'r-anna' ), 'admin', 'assigned' ),
		'assigned to you, by your roster row'    => array(
			array(
				'assignedTo' => 'r-me',
				'status'     => 'assigned',
			),
			'standard',
			null,
		),
		'an id that is your user, not your row'  => array( array( 'assignedTo' => 'u-me' ), 'standard', 'assigned' ),
		'in review waits too'                    => array( array( 'status' => 'in_review' ), 'standard', null ),
	);
	foreach ( $cases as $what => list( $changes, $role, $why ) ) {
		$reviewer = null === $role ? null : kindgi_test_reviewer( $role );
		kindgi_assert_same( $why, Kindgi_Inbox::not_yours( kindgi_test_approval( $changes ), 'u-me', $reviewer ), $what );
		$card = Kindgi_Inbox::card( kindgi_test_approval( $changes ), 'u-me', $reviewer, kindgi_test_names() );
		kindgi_assert_same( null === $why ? 'you' : 'others', $card['waitsFor'], $what . ': its list' );
	}
}

function test_inbox_an_approvals_conversation_opens_for_its_reviewer_and_whoever_asked(): void {
	$card = static function ( array $changes, ?array $reviewer ): array {
		return Kindgi_Inbox::card( kindgi_test_approval( $changes ), 'u-me', $reviewer, kindgi_test_names() );
	};
	$waits = $card( array(), kindgi_test_reviewer() );
	kindgi_assert( Kindgi_Inbox::reviews( $waits ) && $waits['opens'], 'it waits for me: I review it' );
	$senior = $card( array( 'requiredRole' => 'senior' ), kindgi_test_reviewer() );
	kindgi_assert( ! Kindgi_Inbox::reviews( $senior ) && ! $senior['opens'], 'a senior reviewer decides it: not mine to read' );
	$no_role = $card( array(), null );
	kindgi_assert( ! $no_role['opens'], 'no reviewer, no conversation' );
	$asked = $card(
		array(
			'requestedBy'      => 'user:u-me',
			'separateApprover' => true,
		),
		kindgi_test_reviewer()
	);
	kindgi_assert( ! Kindgi_Inbox::reviews( $asked ) && $asked['opens'], 'I asked: the link shows, and it opens as mine' );
	$decision = static function ( string $by ): array {
		return array(
			'status'   => 'approved',
			'decision' => array(
				'decision'  => 'approve',
				'decidedAt' => '2026-11-01T05:44:29Z',
				'decidedBy' => $by,
			),
		);
	};
	$decided = $card( $decision( 'user:u-me' ), kindgi_test_reviewer() );
	kindgi_assert( Kindgi_Inbox::reviews( $decided ) && $decided['opens'], 'I decided it' );
	$by_anna = $card( $decision( 'user:u-anna' ), kindgi_test_reviewer() );
	kindgi_assert( ! $by_anna['opens'], 'Anna decided it: hers' );
	$no_conversation = $card( array( 'subjectKind' => 'flow:review' ), kindgi_test_reviewer() );
	kindgi_assert( ! $no_conversation['opens'], 'nothing to open' );
}

function test_inbox_the_reviewer_is_kindgis_roster_row_and_what_it_may_decide(): void {
	$reviewer = array(
		'role'      => 'senior',
		'id'        => 'r-me',
		'decides'   => array( 'standard', 'senior' ),
		'canDecide' => true,
	);
	kindgi_assert_same(
		array(
			'id'      => 'r-me',
			'role'    => 'senior',
			'decides' => array( 'standard', 'senior' ),
		),
		Kindgi_Inbox::reviewer_of( array( 'reviewer' => $reviewer ) ),
		"the roster row and Kindgi's own ladder"
	);
	kindgi_assert_same( null, Kindgi_Inbox::reviewer_of( array() ), 'no reviewer role' );
	$no_row = array(
		'role'      => 'standard',
		'decides'   => array( 'standard' ),
		'canDecide' => false,
	);
	kindgi_assert_same( null, Kindgi_Inbox::reviewer_of( array( 'reviewer' => $no_row ) ), 'a role without a row on the roster decides nothing' );
}

function test_inbox_a_decided_card_waits_for_nobody_and_names_who_decided(): void {
	$card = Kindgi_Inbox::card(
		kindgi_test_approval(
			array(
				'status'   => 'approved',
				'decision' => array(
					'decision'  => 'approve',
					'decidedAt' => '2026-11-01T05:44:29Z',
					'decidedBy' => 'user:u-anna',
				),
			)
		),
		'u-me',
		kindgi_test_reviewer(),
		kindgi_test_names()
	);
	kindgi_assert_same( null, $card['waitsFor'], 'decided' );
	kindgi_assert_same( 'Anna', $card['decision']['by'], 'her name on this site' );
	kindgi_assert_same( false, $card['decision']['byMe'], 'not mine' );
	$withdrawn = Kindgi_Inbox::card(
		kindgi_test_approval(
			array(
				'status'   => 'withdrawn',
				'decision' => array(
					'decision'  => 'withdraw',
					'decidedAt' => '2026-11-01T05:44:29Z',
					'decidedBy' => 'user:u-anna',
				),
			)
		),
		'u-me',
		kindgi_test_reviewer(),
		kindgi_test_names()
	);
	kindgi_assert_same( null, $withdrawn['decision'], 'a withdrawal is no approve or reject: it reads as the state' );
	kindgi_assert_same( null, $withdrawn['waitsFor'], 'and waits for nobody' );
}

function test_inbox_who_asked_in_words(): void {
	$names = kindgi_test_names();
	kindgi_assert_same( 'you', Kindgi_Inbox::asked( 'user:u-me', 'u-me', $names )['kind'], 'you' );
	kindgi_assert_same(
		array(
			'kind' => 'person',
			'name' => 'Anna',
		),
		Kindgi_Inbox::asked( 'user:u-anna', 'u-me', $names ),
		'a person here'
	);
	kindgi_assert_same( 'kindgi', Kindgi_Inbox::asked( 'user:u-agency', 'u-me', $names )['kind'], 'someone at Kindgi' );
	kindgi_assert_same( 'none', Kindgi_Inbox::asked( null, 'u-me', $names )['kind'], 'nobody recorded' );
	kindgi_assert_same( 'none', Kindgi_Inbox::asked( 'service_account:sa-1', 'u-me', $names )['kind'], 'a service account is no person' );
}

function test_inbox_words_someone_wrote_are_not_values(): void {
	$cases = array(
		'a sentence'             => array( 'One of the two vases arrived broken.', true ),
		'more than one line'     => array( "Sorry.\nIt's on its way.", true ),
		'twelve words, no stop'  => array( 'please refund the customer for the broken vase and the chipped mug too', true ),
		"a product's name"       => array( 'Blue glazed ceramic vase', false ),
		'an address'             => array( '12 Long Road, Springfield', false ),
		'four words and a stop'  => array( 'Ships to Canada today.', false ),
		'a number'               => array( 210, false ),
		'a list'                 => array( array( 'a b c d e.' ), false ),
	);
	foreach ( $cases as $what => list( $value, $prose ) ) {
		kindgi_assert_same( $prose, Kindgi_Inbox::is_prose( $value ), $what );
	}
}

function test_inbox_words_for_fields_and_values(): void {
	$labels = array(
		'orderId'        => 'Order ID',
		'customer_email' => 'Customer email',
		'imageUrl'       => 'Image URL',
		'amount'         => 'Amount',
		'id'             => 'ID',
		'refund-large'   => 'Refund large',
	);
	foreach ( $labels as $name => $label ) {
		kindgi_assert_same( $label, Kindgi_Inbox::words( $name ), $name );
	}
	kindgi_assert_same( 'yes', Kindgi_Inbox::text_of( true ), 'true' );
	kindgi_assert_same( '—', Kindgi_Inbox::text_of( null ), 'null' );
	kindgi_assert_same( 'many-of-one-item, ships-abroad', Kindgi_Inbox::text_of( array( 'many-of-one-item', 'ships-abroad' ) ), 'a list of words' );
	kindgi_assert_same( '{"a":1}', Kindgi_Inbox::text_of( array( 'a' => 1 ) ), 'an object' );
	kindgi_assert_same( 300, mb_strlen( Kindgi_Inbox::text_of( str_repeat( 'é', 400 ) ) ), 'cut short' );
	kindgi_assert_same( array(), Kindgi_Inbox::facts( array( 1, 2 ) ), 'a list has no fields to name' );
	kindgi_assert_same( array(), Kindgi_Inbox::facts( 'refund' ), 'nor does a string' );
}

function test_inbox_a_count_is_kept_a_minute_as_wordpress_hands_it_back(): void {
	$user = new WP_User( 7, 'Anna', array( 'shop_manager' ) );
	kindgi_assert_same( null, Kindgi_Inbox::count( $user ), 'not connected' );
	$kept = array(
		'n'      => 2,
		'more'   => false,
		'orders' => array( '18' => 'you' ),
	);
	Kindgi_Inbox::keep_count( 7, $kept );
	kindgi_assert_same( $kept, Kindgi_Inbox::count( $user ), 'a kept count' );
	kindgi_assert_same( $kept, Kindgi_Inbox::kept_count( 7 ), 'what the menu shows' );
	Kindgi_Inbox::keep_count( 7, null );
	kindgi_assert_same( null, Kindgi_Inbox::count( $user ), 'a kept failure shows nothing' );
	kindgi_assert_same( null, Kindgi_Inbox::kept_count( 7 ), 'nor on the menu' );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['requests'], 'and Kindgi is not asked again in the minute' );
	Kindgi_Inbox::forget_count( 7 );
	kindgi_assert_same( null, Kindgi_Inbox::kept_count( 7 ), 'forgotten' );
	// A number kept by an older copy comes back from the options table as text: no count.
	foreach ( array( 2, -1 ) as $old ) {
		set_transient( Kindgi_Inbox::COUNT . 7, $old );
		kindgi_assert_same( '' . $old, get_transient( Kindgi_Inbox::COUNT . 7 ), 'as WordPress returns it' );
		kindgi_assert_same( null, Kindgi_Inbox::kept_count( 7 ), 'read as no count' );
	}
	set_transient(
		Kindgi_Inbox::COUNT . 7,
		array(
			'n'    => 2,
			'more' => false,
		)
	);
	kindgi_assert_same( null, Kindgi_Inbox::kept_count( 7 ), 'a count kept without its orders is asked again' );
}

function test_inbox_a_count_is_asked_only_on_a_session_the_person_still_has(): void {
	$jane = kindgi_test_jane_known();
	Kindgi_Sessions::forget( $jane->ID );
	$GLOBALS['kindgi_test']['requests'] = array();
	kindgi_assert_same( null, Kindgi_Inbox::count( $jane ), 'no live session: no count' );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['requests'], 'and no sign-in: a page load sends Kindgi nobody' );
	kindgi_assert_same( null, Kindgi_Inbox::kept_count( $jane->ID ), 'nothing kept either' );

	$jane = kindgi_test_jane_known();
	$GLOBALS['kindgi_test']['requests'] = array();
	kindgi_test_answer(
		200,
		array(
			'reviewer' => array(
				'role'      => 'standard',
				'id'        => 'r-jane',
				'decides'   => array( 'standard' ),
				'canDecide' => true,
			),
		)
	);
	kindgi_test_answer(
		200,
		array(
			'data'    => array(
				kindgi_test_approval( array( 'context' => kindgi_test_about_order( '18' ) ) ),
				kindgi_test_approval(
					array(
						'assignedTo' => 'r-jane',
						'status'     => 'assigned',
					)
				),
				kindgi_test_approval(
					array(
						'requiredRole' => 'senior',
						'context'      => kindgi_test_about_order( '19' ),
					)
				),
			),
			'hasMore' => true,
		)
	);
	$count = array(
		'n'      => 2,
		'more'   => true,
		'orders' => array(
			'18' => 'you',
			'19' => 'others',
		),
	);
	kindgi_assert_same( $count, Kindgi_Inbox::count( $jane ), "two of the page are hers, and there's another page; the orders they're about" );
	kindgi_assert_same( 2, count( $GLOBALS['kindgi_test']['requests'] ), 'her permissions and one page, on her session' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][1][0], 'status=pending%2Cassigned%2Cin_review' ), 'every waiting state' );
	kindgi_assert_same( $count, Kindgi_Inbox::kept_count( $jane->ID ), 'kept for the menu' );

	Kindgi_Inbox::forget_count( $jane->ID );
	$GLOBALS['kindgi_test']['requests'] = array();
	kindgi_test_answer( 401, array( 'error' => array( 'code' => 'session-ended' ) ) );
	kindgi_assert_same( null, Kindgi_Inbox::count( $jane ), 'Kindgi ended her session' );
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['requests'] ), 'and she is not signed in again' );
	kindgi_assert_same( null, Kindgi_Sessions::kept( $jane->ID ), 'the ended session is forgotten' );
}

function test_activity_a_webhook_runs_row(): void {
	$row = Kindgi_Activity::row(
		array(
			'id'        => 'r-1',
			'status'    => 'completed',
			'createdAt' => '2026-11-01T05:56:00Z',
			'flowId'    => 'acme-desk.order-review',
			'startedBy' => 'webhook',
			'trigger'   => array(
				'triggerId' => 't-1',
				'kind'      => 'webhook',
			),
			'output'    => array(
				'orderId' => 26,
				'flags'   => array( 'many-of-one-item' ),
			),
		),
		'u-me',
		kindgi_test_names(),
		true
	);
	kindgi_assert_same( 'Order review', $row['flow'], 'the flow in words' );
	kindgi_assert_same( 'webhook', $row['startedBy']['kind'], 'a webhook started it' );
	kindgi_assert_same( 'Order ID 26 · Flags many-of-one-item', $row['summary'], 'its output in one line' );
	kindgi_assert_same( false, $row['said'], 'its fields, not words of its own' );
	kindgi_assert( false !== strpos( (string) $row['output'], '"many-of-one-item"' ), 'the whole output, a click away' );
	kindgi_assert_same( null, $row['private'], 'for someone who can edit orders' );
}

function test_activity_what_a_webhook_run_found_needs_the_orders(): void {
	$row = Kindgi_Activity::row(
		array(
			'id'             => 'r-1',
			'status'         => 'failed',
			'flowId'         => 'acme-desk.order-review',
			'startedBy'      => 'webhook',
			'output'         => array( 'orderId' => 26 ),
			'failureMessage' => 'Order 26 has no address.',
		),
		'u-me',
		kindgi_test_names(),
		false
	);
	kindgi_assert_same( 'orders', $row['private'], "the store's orders" );
	kindgi_assert_same( null, $row['summary'], 'no summary' );
	kindgi_assert_same( null, $row['output'], 'no output' );
	kindgi_assert_same( null, $row['failureMessage'], 'nor why it failed' );
	kindgi_assert_same( 'failed', $row['status'], 'its state still shows' );
}

function test_activity_a_persons_run_and_its_answer(): void {
	$row = Kindgi_Activity::row(
		array(
			'id'        => 'r-2',
			'status'    => 'completed',
			'startedBy' => 'person',
			'actsFor'   => 'user:u-anna',
			'agent'     => array(
				'id'             => 'acme-desk.store-agent',
				'conversationId' => 'c-2',
			),
			'output'    => array( 'text' => "I refunded 210.00 on order 18.\nThe refund ID is 24." ),
		),
		'u-me',
		kindgi_test_names(),
		true
	);
	kindgi_assert_same( 'Anna', $row['startedBy']['name'], 'a person here' );
	kindgi_assert_same( 'someone-else', $row['private'], "Anna's run is hers" );
	kindgi_assert_same( null, $row['summary'], 'one line: who, which agent, when and its state' );
	kindgi_assert_same( null, $row['output'], 'no output' );
	kindgi_assert_same( null, $row['conversationId'], 'and no conversation to open' );
	kindgi_assert_same( 'acme-desk.store-agent', $row['agentId'], 'its agent shows' );
	$mine = Kindgi_Activity::row(
		array(
			'id'        => 'r-3',
			'status'    => 'completed',
			'startedBy' => 'person',
			'actsFor'   => 'user:u-me',
			'agent'     => array(
				'id'             => 'acme-desk.store-agent',
				'conversationId' => 'c-2',
			),
			'output'    => array( 'text' => "I refunded 210.00 on order 18.\nThe refund ID is 24." ),
		),
		'u-me',
		kindgi_test_names(),
		false
	);
	kindgi_assert_same( 'you', $mine['startedBy']['kind'], 'my own run' );
	kindgi_assert_same( 'I refunded 210.00 on order 18.', $mine['summary'], "the answer's first line" );
	kindgi_assert_same( true, $mine['said'], "the agent's own words, quoted" );
	kindgi_assert_same( 'c-2', $mine['conversationId'], 'its conversation' );
	kindgi_assert_same( null, $mine['private'], 'my own, orders or not' );
	$started = array(
		'startedBy' => 'person',
		'actsFor'   => 'user:u-me',
	);
	kindgi_assert( Kindgi_Rest::started( $started, 'u-me' ), 'a turn I sent' );
	kindgi_assert( ! Kindgi_Rest::started( array_merge( $started, array( 'startedBy' => 'schedule' ) ), 'u-me' ), 'a schedule acting for me is no turn of mine' );
	kindgi_assert( ! Kindgi_Rest::started( $started, 'u-anna' ), "someone else's" );
	kindgi_assert( ! Kindgi_Rest::started( $started, '' ), 'nobody' );
	kindgi_assert_same( 'unknown', Kindgi_Activity::started_by( array(), 'u-me', kindgi_test_names() )['kind'], 'a run from before runs recorded it' );
	kindgi_assert_same( 'Order ID 26', Kindgi_Activity::summary( array( 'orderId' => 26 ) ), 'a field in words' );
	kindgi_assert_same(
		'Order 26 is for 6 mugs.',
		Kindgi_Activity::summary(
			array(
				'flags'  => array( 'many-of-one-item' ),
				'review' => "Order 26 is for 6 mugs.\nCheck the **address**.",
			)
		),
		'a flow that answers in words, in a field of its own'
	);
	$turn = array(
		'runId'    => 'r-2',
		'appended' => array(
			array(
				'role'    => 'user',
				'content' => 'Refund order 18',
			),
		),
		'response' => array(
			'role'    => 'agent',
			'content' => 'I refunded 210.00 on order 18.',
		),
		'usage'    => array( 'steps' => 4 ),
	);
	kindgi_assert_same( 'I refunded 210.00 on order 18.', Kindgi_Activity::summary( $turn ), "an agent's turn: its answer, not its usage" );
	kindgi_assert_same( 'The many-of-one-item flag', Kindgi_Activity::summary( 'The **`many-of-one-item`** flag' ), "Markdown's marks left out" );
	kindgi_assert_same( 'I refunded 210.00 on order 18.', Kindgi_Activity::output( $turn ), 'and its output is the answer, whole' );
	kindgi_assert_same( null, Kindgi_Activity::summary( array( 1, 2 ) ), 'a list has nothing to say' );
	kindgi_assert_same( null, Kindgi_Activity::summary( null ), 'no output' );
	kindgi_assert_same( null, Kindgi_Activity::summary( "\n\n" ), 'an empty answer' );
}

function test_admin_the_offer_form_offers_all_some_or_none(): void {
	$shown = array( 'acme-desk.store-agent', 'acme-desk.order-reviewer' );
	kindgi_assert_same( null, Kindgi_Admin::offered_after( $shown, $shown ), 'every one ticked: all, and any deployed later' );
	kindgi_assert_same( array( 'acme-desk.store-agent' ), Kindgi_Admin::offered_after( $shown, array( 'acme-desk.store-agent' ) ), 'some: only those' );
	kindgi_assert_same( array(), Kindgi_Admin::offered_after( $shown, array() ), 'none ticked: none offered' );
}
