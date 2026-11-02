<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Jane's Kindgi id, as her session names her. */
const KINDGI_TEST_JANE = '3726b1e7-4c1e-4b6a-9d84-0b172f5e8d9c';

/** A run of the project's, as Kindgi lists it. */
function kindgi_test_run( array $changes ): array {
	return array_merge(
		array(
			'id'        => 'r-1',
			'status'    => 'completed',
			'createdAt' => '2026-11-01T06:00:00Z',
			'startedBy' => 'person',
			'actsFor'   => 'user:' . KINDGI_TEST_JANE,
			'agent'     => array(
				'id'             => 'acme-desk.store-agent',
				'conversationId' => 'c-1',
			),
			'output'    => array( 'text' => 'Order 18 shipped on Monday.' ),
		),
		$changes
	);
}

function test_dashboard_the_box_asks_kindgi_nothing_without_a_live_session(): void {
	$jane = kindgi_test_jane_at_work();
	Kindgi_Sessions::forget( $jane->ID );
	$answer = Kindgi_Rest::dashboard( new WP_REST_Request( array( 'signIn' => false ) ) );
	kindgi_assert_same( array( 'signedIn' => false ), $answer, 'it says so' );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['requests'], 'and nobody is signed in by opening the dashboard' );
}

function test_dashboard_the_box_names_what_waits_for_her_and_the_latest_runs(): void {
	kindgi_test_jane_at_work();
	kindgi_test_answer_reviewer();
	kindgi_test_answer(
		200,
		array(
			'data'    => array(
				kindgi_test_approval(
					array(
						'id'            => 'ap-1',
						'provenanceRef' => array( 'runId' => 'r-mine' ),
					)
				),
				kindgi_test_approval(
					array(
						'id'            => 'ap-senior',
						'requiredRole'  => 'senior',
						'provenanceRef' => array( 'runId' => 'r-anna' ),
					)
				),
				kindgi_test_approval( array( 'id' => 'ap-2' ) ),
				kindgi_test_approval( array( 'id' => 'ap-3' ) ),
			),
			'hasMore' => false,
		)
	);
	kindgi_test_answer(
		200,
		array(
			'data'       => array(
				kindgi_test_run( array( 'id' => 'r-mine' ) ),
				kindgi_test_run(
					array(
						'id'        => 'r-webhook',
						'startedBy' => 'webhook',
						'actsFor'   => null,
						'agent'     => null,
						'flowId'    => 'acme-desk.order-review',
						'output'    => array( 'orderId' => 26 ),
					)
				),
				kindgi_test_run(
					array(
						'id'      => 'r-anna',
						'status'  => 'suspended',
						'actsFor' => 'user:u-anna',
					)
				),
			),
			'nextCursor' => 'more',
		)
	);
	kindgi_test_answer(
		200,
		array(
			'data' => array(
				array(
					'id'   => 'acme-desk.store-agent',
					'name' => 'Store agent',
				),
			),
		)
	);
	$answer = Kindgi_Rest::dashboard( new WP_REST_Request( array( 'signIn' => false ) ) );
	kindgi_assert_same( true, $answer['signedIn'], 'on her live session' );
	kindgi_assert_same( 3, $answer['count'], "three wait for her, not the senior reviewer's" );
	kindgi_assert_same( array( 'ap-1', 'ap-2' ), array_column( $answer['waiting'], 'id' ), 'the oldest two of hers are named' );
	kindgi_assert_same( 'Refund large', substr( $answer['waiting'][0]['heading'], 0, 12 ), 'by their headings' );
	kindgi_assert_same( array( 'Store agent', 'Order review', 'Store agent' ), array_column( $answer['runs'], 'name' ), "the agent's name, or the flow's" );
	kindgi_assert_same( 'Order 18 shipped on Monday.', $answer['runs'][0]['summary'], 'her run in its first line' );
	kindgi_assert_same( 'Order ID 26', $answer['runs'][1]['summary'], 'the store\'s: she may edit orders' );
	kindgi_assert_same( null, $answer['runs'][2]['summary'], "Anna's: not what it found" );
	kindgi_assert_same( 'suspended', $answer['runs'][2]['status'], 'only that it waits' );
	kindgi_assert_same(
		array(
			array(
				'id'      => 'ap-senior',
				'heading' => 'Refund large',
			),
		),
		$answer['runs'][2]['waiting'],
		'and for which approval, from the page read for the count: the one that names it'
	);
	kindgi_assert_same( array(), $answer['runs'][0]['waiting'], 'a run that ended waits for nothing, whatever names it' );
	kindgi_assert_same( 4, count( $GLOBALS['kindgi_test']['requests'] ), 'her permissions, then three lists: no sign-in' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][2][0], 'limit=3' ), 'only the latest runs' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][2][0], 'topLevel=true' ), "not a flow's own steps" );
	kindgi_assert_same( 3, Kindgi_Inbox::kept_count( 7 )['n'], 'the waiting page is kept as her count, for the menu' );
}

function test_dashboard_the_count_in_words(): void {
	kindgi_assert_same( 'Nothing waits for you.', Kindgi_Dashboard::waits_html( 0, false ), 'none' );
	kindgi_assert( false !== strpos( Kindgi_Dashboard::waits_html( 1, false ), '>1 approval waits for you</a>' ), 'one, linked' );
	kindgi_assert( false !== strpos( Kindgi_Dashboard::waits_html( 12, true ), '>12+ approvals wait for you</a>' ), 'more than a page' );
	kindgi_assert( false !== strpos( Kindgi_Dashboard::waits_html( 1, false ), 'page=kindgi"' ), 'to the Inbox' );
}

function test_dashboard_a_new_version_waiting_is_named_by_the_agents_name(): void {
	$answer = Kindgi_Dashboard::answer(
		array(
			'waiting' => array( 'data' => array( kindgi_test_pin() ) ),
			'runs'    => array( 'data' => array() ),
			'agents'  => array(
				'data' => array(
					array(
						'id'   => 'acme-desk.support-desk',
						'name' => 'Ceramics help',
					),
				),
			),
		),
		array(
			'n'    => 1,
			'more' => false,
		),
		'u-me',
		kindgi_test_reviewer( 'senior' )
	);
	kindgi_assert_same( 'Update Ceramics help to version 0.1.2', $answer['waiting'][0]['heading'], "from the agents' page the box reads" );
}
