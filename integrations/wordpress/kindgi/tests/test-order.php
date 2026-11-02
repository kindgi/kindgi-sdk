<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** An approval's `context` when its tool says it's about this WooCommerce order. */
function kindgi_test_about_order( $id ): array {
	return array(
		'about' => array(
			'kind' => 'woocommerce.order',
			'id'   => $id,
		),
	);
}

/** Jane, signed in at Kindgi, using wp-admin; she may use Kindgi and, with `$edits_orders`, edit orders. */
function kindgi_test_jane_at_work( bool $edits_orders = true ): WP_User {
	$jane                                   = kindgi_test_jane_known();
	$GLOBALS['kindgi_test']['current_user'] = $jane;
	$GLOBALS['kindgi_test']['caps']         = $edits_orders ? array( Kindgi_Admin::capability(), 'edit_shop_orders' ) : array( Kindgi_Admin::capability() );
	$GLOBALS['kindgi_test']['orders'][18]   = new WC_Order( 18 );
	$GLOBALS['kindgi_test']['requests']     = array();
	return $jane;
}

/** Kindgi's answer to `/v1/identity/me/permissions` for a standard reviewer. */
function kindgi_test_answer_reviewer(): void {
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
}

function test_order_an_approval_is_about_an_order_when_its_tool_says(): void {
	$about = static function ( array $context ): ?array {
		return Kindgi_Inbox::about_of( array( 'context' => $context ) );
	};
	kindgi_assert_same( null, Kindgi_Inbox::about_of( array() ), 'no context' );
	kindgi_assert_same( null, $about( array( 'about' => array( 'kind' => 'woocommerce.order' ) ) ), 'no id' );
	kindgi_assert_same(
		array(
			'kind' => 'woocommerce.order',
			'id'   => '18',
		),
		$about( kindgi_test_about_order( 18 ) ),
		'an id as a number reads as text'
	);
	kindgi_assert_same( 18, Kindgi_Order::of( $about( kindgi_test_about_order( '18' ) ) ), 'an order' );
	foreach ( array( '0', '018', '18a', '-3', '' ) as $id ) {
		kindgi_assert_same( null, Kindgi_Order::of( $about( kindgi_test_about_order( $id ) ) ), "no order number: '{$id}'" );
	}
	kindgi_assert_same(
		null,
		Kindgi_Order::of(
			array(
				'kind' => 'woocommerce.product',
				'id'   => '18',
			)
		),
		'a product is no order'
	);
	kindgi_assert_same( null, Kindgi_Order::of( null ), 'about nothing it says' );
	$card = Kindgi_Inbox::card( kindgi_test_approval( array( 'context' => kindgi_test_about_order( '18' ) ) ), 'u-me', kindgi_test_reviewer(), kindgi_test_names() );
	kindgi_assert_same( '18', $card['about']['id'], 'the card says what it is about' );
}

function test_order_a_count_says_which_orders_wait_and_for_whom(): void {
	$page = array(
		'data'    => array(
			// About order 18: the first is a senior's, the second is mine.
			kindgi_test_approval(
				array(
					'requiredRole' => 'senior',
					'context'      => kindgi_test_about_order( '18' ),
				)
			),
			kindgi_test_approval( array( 'context' => kindgi_test_about_order( '18' ) ) ),
			kindgi_test_approval(
				array(
					'requiredRole' => 'senior',
					'context'      => kindgi_test_about_order( '19' ),
				)
			),
			kindgi_test_approval(
				array(
					'status'  => 'approved',
					'context' => kindgi_test_about_order( '20' ),
				)
			),
			kindgi_test_approval(),
		),
		'hasMore' => false,
	);
	kindgi_assert_same(
		array(
			'n'      => 2,
			'more'   => false,
			'orders' => array(
				'18' => 'you',
				'19' => 'others',
			),
		),
		Kindgi_Inbox::count_of( $page, 'u-me', kindgi_test_reviewer() ),
		'one about an order that waits for me marks it mine; a closed one marks none'
	);
	kindgi_assert_same(
		array(
			'18' => 'others',
			'19' => 'others',
		),
		Kindgi_Inbox::count_of( $page, 'u-me', null )['orders'],
		"someone who can't decide sees which orders wait for a reviewer"
	);
}

function test_order_the_column_sits_after_the_status_and_reads_the_kept_count(): void {
	kindgi_assert_same(
		array( 'cb', 'order_number', 'order_status', 'kindgi', 'order_total' ),
		array_keys(
			Kindgi_Order::with_column(
				array(
					'cb'           => '',
					'order_number' => 'Order',
					'order_status' => 'Status',
					'order_total'  => 'Total',
				)
			)
		),
		'after the status'
	);
	kindgi_assert_same( array( 'order_number', 'kindgi' ), array_keys( Kindgi_Order::with_column( array( 'order_number' => 'Order' ) ) ), 'last, without a status' );
	$heading = Kindgi_Order::with_column( array( 'order_number' => 'Order' ) )['kindgi'];
	kindgi_assert( false !== strpos( $heading, '<svg class="kindgi-mark"' ), 'its heading is the mark' );
	kindgi_assert_same( 'Kindgi', trim( strip_tags( $heading ) ), 'and its name, where WordPress shows the heading as text' );
	$count = array(
		'n'      => 1,
		'more'   => false,
		'orders' => array(
			'18' => 'you',
			'19' => 'others',
		),
	);
	kindgi_assert_same( 'you', Kindgi_Order::state( $count, 18 ), 'waits for me' );
	kindgi_assert_same( 'others', Kindgi_Order::state( $count, 19 ), 'waits for a reviewer' );
	kindgi_assert_same( '', Kindgi_Order::state( $count, 21 ), 'nothing waits' );
	kindgi_assert_same( null, Kindgi_Order::state( null, 18 ), 'no count kept: not known yet' );
	kindgi_assert_same( 'Waits for you', Kindgi_Order::waits_words( 'you' ), 'mine in words' );
	kindgi_assert_same( 'Waits for a reviewer', Kindgi_Order::waits_words( 'others' ), "someone else's in words" );
	kindgi_assert_same( '', Kindgi_Order::waits_words( '' ), 'none: an empty cell' );
}

function test_order_a_decision_note_says_what_was_decided_and_by_whom(): void {
	$heading = 'Large refund: 210 on order #18';
	kindgi_assert_same( 'Kindgi: Large refund: 210 on order #18. Approved by Jane.', Kindgi_Order::note_text( $heading, 'approve', '', 'Jane' ), 'approved' );
	kindgi_assert_same( 'Kindgi: Large refund: 210 on order #18. Approved by Jane: The photo shows both broken.', Kindgi_Order::note_text( $heading, 'approve', 'The photo shows both broken.', 'Jane' ), 'approved, saying why' );
	kindgi_assert_same( 'Kindgi: Large refund: 210 on order #18. Rejected by Jane: Only one vase broke.', Kindgi_Order::note_text( $heading, 'reject', 'Only one vase broke.', 'Jane' ), 'rejected, with the reason' );
	kindgi_assert_same( 'Kindgi: Refund order #18. Approved by Jane.', Kindgi_Order::note_text( 'Refund order #18.', 'approve', '', 'Jane' ), 'a title that ends with a period gets one' );
}

function test_order_the_box_asks_kindgi_nothing_without_a_live_session(): void {
	$jane = kindgi_test_jane_at_work();
	Kindgi_Sessions::forget( $jane->ID );
	$answer = Kindgi_Rest::order( new WP_REST_Request( array( 'order' => '18', 'signIn' => false ) ) );
	kindgi_assert_same( array( 'signedIn' => false ), $answer, 'it says so' );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['requests'], 'and nobody is signed in by opening an order' );

	kindgi_test_answer_session();
	kindgi_test_answer_reviewer();
	kindgi_test_answer( 200, array( 'data' => array(), 'hasMore' => false ) );
	kindgi_test_answer( 200, array( 'data' => array(), 'hasMore' => false ) );
	$answer = Kindgi_Rest::order( new WP_REST_Request( array( 'order' => '18', 'signIn' => true ) ) );
	kindgi_assert_same( true, $answer['signedIn'], 'asked to: signed in' );
	kindgi_assert_same( 4, count( $GLOBALS['kindgi_test']['requests'] ), 'the sign-in, then her permissions and two pages' );
}

function test_order_the_box_lists_what_is_about_the_order_for_someone_who_edits_orders(): void {
	kindgi_test_jane_at_work( false );
	$refused = Kindgi_Rest::order( new WP_REST_Request( array( 'order' => '18', 'signIn' => false ) ) );
	kindgi_assert_same( 'kindgi_order_not_found', $refused->get_error_code(), "someone who can't edit orders reads nothing about one" );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['requests'], 'and Kindgi is not asked' );

	kindgi_test_jane_at_work();
	$missing = Kindgi_Rest::order( new WP_REST_Request( array( 'order' => '404', 'signIn' => false ) ) );
	kindgi_assert_same( 'kindgi_order_not_found', $missing->get_error_code(), 'no such order' );

	kindgi_test_answer_reviewer();
	kindgi_test_answer(
		200,
		array(
			'data'    => array(
				kindgi_test_approval(
					array(
						'id'      => 'ap-18',
						'context' => kindgi_test_about_order( '18' ),
					)
				),
				kindgi_test_approval(
					array(
						'id'      => 'ap-19',
						'context' => kindgi_test_about_order( '19' ),
					)
				),
				kindgi_test_approval( array( 'id' => 'ap-none' ) ),
			),
			'hasMore' => false,
		)
	);
	kindgi_test_answer(
		200,
		array(
			'data'    => array(
				kindgi_test_approval(
					array(
						'id'       => 'ap-18-done',
						'status'   => 'approved',
						'context'  => kindgi_test_about_order( '18' ),
						'decision' => array(
							'decision'  => 'approve',
							'decidedAt' => '2026-11-01T06:00:00Z',
							'decidedBy' => 'user:u-anna',
						),
					)
				),
			),
			'hasMore' => true,
		)
	);
	$answer = Kindgi_Rest::order( new WP_REST_Request( array( 'order' => '18', 'signIn' => false ) ) );
	kindgi_assert_same( array( 'ap-18' ), array_column( $answer['waiting'], 'id' ), 'what waits about order 18 only' );
	kindgi_assert_same( 'you', $answer['waiting'][0]['waitsFor'], 'hers to decide' );
	kindgi_assert_same( array( 'ap-18-done' ), array_column( $answer['closed'], 'id' ), 'and what was decided about it' );
	kindgi_assert_same( true, $answer['more'], 'another page may hold older ones' );
	kindgi_assert_same( 3, count( $GLOBALS['kindgi_test']['requests'] ), 'on her live session: no sign-in' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][1][0], 'status=pending%2Cassigned%2Cin_review' ), 'every waiting state' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][2][0], 'status=approved%2Crejected%2Cexpired%2Cwithdrawn%2Cescalated' ), 'every closed state' );
	kindgi_assert_same( array( '18' => 'you', '19' => 'you' ), Kindgi_Inbox::kept_count( 7 )['orders'], "the waiting page is kept as her count, for the Orders list" );
}

function test_order_a_decision_on_this_site_leaves_a_private_note_on_the_order(): void {
	kindgi_test_jane_at_work();
	$approved = array(
		'approval'          => kindgi_test_approval(
			array(
				'status'   => 'approved',
				'context'  => array_merge(
					kindgi_test_about_order( '18' ),
					array( 'text' => array( 'title' => 'Large refund: 210 on order #18' ) )
				),
				'decision' => array(
					'decision'  => 'approve',
					'decidedAt' => '2026-11-01T06:00:00Z',
					'decidedBy' => 'user:3726b1e7-4c1e-4b6a-9d84-0b172f5e8d9c',
				),
			)
		),
		'waitpointResolved' => true,
	);
	kindgi_test_answer( 200, $approved );
	$done = Kindgi_Rest::decide( new WP_REST_Request( array( 'id' => 'ap-1', 'decision' => 'approve', 'reason' => '' ) ) );
	kindgi_assert_same( true, $done['waitpointResolved'], 'decided' );
	kindgi_assert_same(
		array( array( 'Kindgi: Large refund: 210 on order #18. Approved by Jane.', 0, true ) ),
		$GLOBALS['kindgi_test']['orders'][18]->notes,
		'a private note, by her'
	);

	$GLOBALS['kindgi_test']['orders'][18] = new WC_Order( 18 );
	$elsewhere                            = $approved;
	$elsewhere['approval']['context']     = array();
	kindgi_test_answer( 200, $elsewhere );
	Kindgi_Rest::decide( new WP_REST_Request( array( 'id' => 'ap-1', 'decision' => 'approve', 'reason' => '' ) ) );
	kindgi_assert_same( array(), $GLOBALS['kindgi_test']['orders'][18]->notes, 'an approval about no order leaves no note' );

	kindgi_test_jane_at_work( false );
	kindgi_test_answer( 200, $approved );
	Kindgi_Rest::decide( new WP_REST_Request( array( 'id' => 'ap-1', 'decision' => 'approve', 'reason' => '' ) ) );
	kindgi_assert_same(
		array( array( 'Kindgi: Large refund: 210 on order #18. Approved by Jane.', 0, true ) ),
		$GLOBALS['kindgi_test']['orders'][18]->notes,
		"a decider who can't edit orders leaves the note too, for whoever may edit the order"
	);
}

/** One waiting approval, about order 18, that a standard reviewer decides. */
function kindgi_test_page_about_18(): array {
	return array(
		'data'    => array( kindgi_test_approval( array( 'context' => kindgi_test_about_order( '18' ) ) ) ),
		'hasMore' => false,
	);
}

function test_order_the_heartbeat_gives_the_orders_only_to_someone_who_sees_the_column(): void {
	$asked = array( 'kindgi_inbox' => true );
	$jane  = kindgi_test_jane_at_work();
	Kindgi_Inbox::forget_count( $jane->ID );
	kindgi_test_answer_reviewer();
	kindgi_test_answer( 200, kindgi_test_page_about_18() );
	$beat = Kindgi_Inbox::heartbeat( array(), $asked );
	kindgi_assert_same( 1, $beat['kindgi_inbox']['n'], 'her count' );
	kindgi_assert_same( array( '18' => 'you' ), $beat['kindgi_inbox']['orders'], 'and, as she edits orders, which orders wait' );

	$jane = kindgi_test_jane_at_work( false );
	Kindgi_Inbox::forget_count( $jane->ID );
	kindgi_test_answer_reviewer();
	kindgi_test_answer( 200, kindgi_test_page_about_18() );
	$beat = Kindgi_Inbox::heartbeat( array(), $asked );
	kindgi_assert_same( 1, $beat['kindgi_inbox']['n'], "her count, when she can't edit orders" );
	kindgi_assert_same( array(), $beat['kindgi_inbox']['orders'], 'and no orders' );
}

function test_order_someone_who_cannot_decide_is_asked_the_page_only_for_the_column(): void {
	$jane = kindgi_test_jane_at_work();
	Kindgi_Inbox::forget_count( $jane->ID );
	kindgi_test_answer( 200, array() );
	kindgi_test_answer( 200, kindgi_test_page_about_18() );
	kindgi_assert_same(
		array(
			'n'      => 0,
			'more'   => false,
			'orders' => array( '18' => 'others' ),
		),
		Kindgi_Inbox::count( $jane ),
		'nothing hers, and order 18 waits for a reviewer'
	);
	kindgi_assert_same( 2, count( $GLOBALS['kindgi_test']['requests'] ), 'her permissions, then the page, on her live session' );

	$jane = kindgi_test_jane_at_work( false );
	Kindgi_Inbox::forget_count( $jane->ID );
	kindgi_test_answer( 200, array() );
	kindgi_assert_same(
		array(
			'n'      => 0,
			'more'   => false,
			'orders' => array(),
		),
		Kindgi_Inbox::count( $jane ),
		"with no column to fill, nothing waits for her"
	);
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['requests'] ), 'her permissions only: no page' );
}
