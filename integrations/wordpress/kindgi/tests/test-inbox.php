<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Names on this site, by `user:<id>`: only `user:u-anna` is one. */
function kindgi_test_names(): callable {
	return static function ( string $principal ): ?string {
		return 'user:u-anna' === $principal ? 'Anna' : null;
	};
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

function test_inbox_a_tool_calls_card_reads_in_words_not_kindgis(): void {
	$card = Kindgi_Inbox::card( kindgi_test_approval(), 'u-me', 'standard', kindgi_test_names() );
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
			array(
				'label' => 'Reason',
				'value' => 'One of the two vases arrived broken.',
			),
		),
		$card['facts'],
		'what would run, field by field'
	);
	kindgi_assert_same( 'you', $card['waitsFor'], 'a standard reviewer decides it' );
	kindgi_assert_same( 'kindgi', $card['asked']['kind'], 'asked by someone this site never signed in' );
	kindgi_assert_same( 'acme-desk.woo.refund-large', $card['details']['toolId'], "Kindgi's ids stay, behind Details" );
	kindgi_assert_same( 'c-1', $card['conversationId'], 'its conversation' );
}

function test_inbox_a_title_a_tool_gives_is_the_heading(): void {
	$card = Kindgi_Inbox::card(
		kindgi_test_approval(
			array(
				'title'       => 'Refund 210 on order #18',
				'description' => 'One of the two vases arrived broken.',
			)
		),
		'u-me',
		'standard',
		kindgi_test_names()
	);
	kindgi_assert_same( 'Refund 210 on order #18', $card['heading'], 'the title' );
	kindgi_assert_same( 'One of the two vases arrived broken.', $card['summary'], 'the description' );
	kindgi_assert_same( 3, count( $card['facts'] ), 'the fields still show: a title can leave one out' );
}

function test_inbox_sorts_what_waits_for_you_from_what_waits_for_others(): void {
	$cases = array(
		'no reviewer role'               => array( array(), null, 'not-a-reviewer' ),
		'a standard one'                 => array( array(), 'standard', null ),
		'needs senior, you are standard' => array( array( 'requiredRole' => 'senior' ), 'standard', 'needs-senior' ),
		'needs senior, you are admin'    => array( array( 'requiredRole' => 'senior' ), 'admin', null ),
		'needs admin, you are senior'    => array( array( 'requiredRole' => 'admin' ), 'senior', 'needs-admin' ),
		'you asked, another decides'     => array(
			array(
				'requestedBy'      => 'user:u-me',
				'separateApprover' => true,
			),
			'standard',
			'you-asked',
		),
		'you asked, anyone decides'      => array( array( 'requestedBy' => 'user:u-me' ), 'standard', null ),
		'assigned to someone else'       => array( array( 'assignedTo' => 'u-anna' ), 'admin', 'assigned' ),
		'assigned to you'                => array( array( 'assignedTo' => 'u-me' ), 'standard', null ),
		'a role Kindgi has no word for'  => array( array(), 'owner', 'not-a-reviewer' ),
	);
	foreach ( $cases as $what => list( $changes, $role, $why ) ) {
		kindgi_assert_same( $why, Kindgi_Inbox::not_yours( kindgi_test_approval( $changes ), 'u-me', $role ), $what );
		$card = Kindgi_Inbox::card( kindgi_test_approval( $changes ), 'u-me', $role, kindgi_test_names() );
		kindgi_assert_same( null === $why ? 'you' : 'others', $card['waitsFor'], $what . ': its list' );
	}
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
		'standard',
		kindgi_test_names()
	);
	kindgi_assert_same( null, $card['waitsFor'], 'decided' );
	kindgi_assert_same( 'Anna', $card['decision']['by'], 'her name on this site' );
	kindgi_assert_same( false, $card['decision']['byMe'], 'not mine' );
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

function test_inbox_a_count_is_kept_a_minute_and_never_asked_for_someone_kindgi_never_saw(): void {
	$user = new WP_User( 7, 'Anna', array( 'shop_manager' ) );
	kindgi_assert_same( null, Kindgi_Inbox::count( $user ), 'not connected' );
	update_option(
		Kindgi_Settings::SITE_OPTION,
		array(
			'site_id'     => 'site-1',
			'audience'    => 'https://kindgi.acme.example',
			'kid'         => 'k',
			'origin'      => 'https://acme-store.example',
			'enrolled_at' => 1,
		)
	);
	kindgi_assert_same( null, Kindgi_Inbox::count( $user ), 'never signed in from here' );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['requests'], 'and Kindgi was never asked' );
	set_transient( Kindgi_Inbox::COUNT . 7, 2 );
	kindgi_assert_same( 2, Kindgi_Inbox::count( $user ), 'a kept count' );
	kindgi_assert_same( 2, Kindgi_Inbox::kept_count( 7 ), 'what the menu shows' );
	set_transient( Kindgi_Inbox::COUNT . 7, -1 );
	kindgi_assert_same( null, Kindgi_Inbox::count( $user ), 'a kept failure shows nothing' );
	kindgi_assert_same( null, Kindgi_Inbox::kept_count( 7 ), 'nor on the menu' );
	Kindgi_Inbox::forget_count( 7 );
	kindgi_assert_same( null, Kindgi_Inbox::kept_count( 7 ), 'forgotten' );
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
		kindgi_test_names()
	);
	kindgi_assert_same( 'Order review', $row['flow'], 'the flow in words' );
	kindgi_assert_same( 'webhook', $row['startedBy']['kind'], 'a webhook started it' );
	kindgi_assert_same( 'Order ID 26 · Flags many-of-one-item', $row['summary'], 'its output in one line' );
	kindgi_assert( false !== strpos( (string) $row['output'], '"many-of-one-item"' ), 'the whole output, a click away' );
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
		kindgi_test_names()
	);
	kindgi_assert_same( 'Anna', $row['startedBy']['name'], 'a person here' );
	kindgi_assert_same( 'I refunded 210.00 on order 18.', $row['summary'], "the answer's first line" );
	kindgi_assert_same( 'c-2', $row['conversationId'], 'its conversation' );
	kindgi_assert_same( 'unknown', Kindgi_Activity::started_by( array(), 'u-me', kindgi_test_names() )['kind'], 'a run from before runs recorded it' );
	kindgi_assert_same( 'Order ID 26', Kindgi_Activity::summary( array( 'orderId' => 26 ) ), 'a field in words' );
	kindgi_assert_same( null, Kindgi_Activity::summary( array( 1, 2 ) ), 'a list has nothing to say' );
	kindgi_assert_same( null, Kindgi_Activity::summary( null ), 'no output' );
	kindgi_assert_same( null, Kindgi_Activity::summary( "\n\n" ), 'an empty answer' );
}
