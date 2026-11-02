<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A turn mail started, as `mailTurn` writes it: an earlier mail, one left out, the mailbox's reply, and the new mail. */
function kindgi_test_mail_turn(): string {
	return implode(
		"\n",
		array(
			'Mail thread "Order 27 - can it ship before Friday?": 4 mails, 3 shown, oldest first',
			'--- Pat <pat@example.com>, 2026-10-30 09:12 UTC',
			'Is the blue vase back in stock?',
			'--- 1 mail left out ---',
			'--- support@example.com (this mailbox), 2026-10-31 10:00 UTC, subject "Blue vase"',
			'Hello Pat,',
			' --- the team',
			'--- NEW, id 01a19968063e2c57: Smith, Pat <pat@example.com>, 2026-11-01 23:17 UTC',
			'To: support@example.com · Cc: Anna <anna@example.com>',
			'Hi,',
			'',
			'Can it ship before Friday?',
			'[the rest of this mail is cut]',
			'Attachments: 1. receipt.pdf (application/pdf, 12 KB)',
		)
	);
}

function test_mail_a_turn_reads_back_as_its_thread(): void {
	$thread = Kindgi_Mail::thread_of( kindgi_test_mail_turn() );
	kindgi_assert_same( 'Order 27 - can it ship before Friday?', $thread['subject'], "the thread's subject" );
	kindgi_assert_same( 1, $thread['leftOut'], 'one mail the agent was not given' );
	kindgi_assert_same( 3, count( $thread['mails'] ), 'the mails it was, oldest first' );
	list( $first, $reply, $new ) = $thread['mails'];
	kindgi_assert_same(
		array(
			'name'    => 'Pat',
			'address' => 'pat@example.com',
			'mine'    => false,
			'unsure'  => false,
		),
		$first['from'],
		'who wrote first'
	);
	kindgi_assert_same( '2026-10-30T09:12:00Z', $first['at'], 'and when' );
	kindgi_assert_same( 'Is the blue vase back in stock?', $first['text'], 'its text' );
	kindgi_assert_same( false, $first['new'], 'an earlier mail' );
	kindgi_assert_same( true, $reply['from']['mine'], "the mailbox's own sent mail" );
	kindgi_assert_same( 'Blue vase', $reply['subject'], 'its own subject, apart from the thread' );
	kindgi_assert_same( "Hello Pat,\n--- the team", $reply['text'], 'a line set in so it reads as text is as written' );
	kindgi_assert_same( true, $new['new'], 'the mail that started the turn' );
	kindgi_assert_same( 'Smith, Pat', $new['from']['name'], 'a name with a comma in it' );
	kindgi_assert_same(
		array(
			array(
				'kind' => 'To',
				'who'  => 'support@example.com',
			),
			array(
				'kind' => 'Cc',
				'who'  => 'Anna <anna@example.com>',
			),
		),
		$new['recipients'],
		'whom it went to'
	);
	kindgi_assert_same( "Hi,\n\nCan it ship before Friday?", $new['text'], 'its text' );
	kindgi_assert_same( true, $new['cut'], 'cut for the agent' );
	kindgi_assert_same( '1. receipt.pdf (application/pdf, 12 KB)', $new['attachments'], 'what it carries' );
}

function test_mail_who_a_mail_is_from(): void {
	kindgi_assert_same( 'pat@example.com', Kindgi_Mail::from( 'pat@example.com' )['address'], 'an address alone' );
	kindgi_assert_same( null, Kindgi_Mail::from( 'pat@example.com' )['name'], 'with no name' );
	kindgi_assert_same( null, Kindgi_Mail::from( '(no sender)' )['address'], 'no sender' );
	$unsure = Kindgi_Mail::from( "Support <support@example.com> (this mailbox's address, not its sent mail)" );
	kindgi_assert_same( array( 'Support', 'support@example.com', false, true ), array( $unsure['name'], $unsure['address'], $unsure['mine'], $unsure['unsure'] ), "the mailbox's address on mail it didn't send" );
}

function test_mail_a_turn_mail_did_not_start_reads_as_written(): void {
	kindgi_assert_same( null, Kindgi_Mail::thread_of( 'Which orders are still processing?' ), 'a question' );
	kindgi_assert_same( null, Kindgi_Mail::thread_of( "Mail thread \"Hi\": 1 mail, 1 shown, oldest first\nHello" ), 'text before any mail' );
	kindgi_assert_same( null, Kindgi_Mail::thread_of( 'Mail thread "Hi": 1 mail, 1 shown, oldest first' ), 'no mail at all' );
	$empty = Kindgi_Mail::thread_of( "Mail thread \"Hi\": 1 new mail, 1 shown, oldest first\n--- NEW, id m-1: (no sender), 2026-11-01 08:00 UTC\n(no text)" );
	kindgi_assert_same( '', $empty['mails'][0]['text'], 'a mail with no text, on a linked conversation' );
	kindgi_assert_same( array(), $empty['mails'][0]['recipients'], 'and none it names' );
}

function test_mail_a_conversations_turn_comes_with_its_thread(): void {
	kindgi_test_jane_at_work();
	kindgi_test_answer( 200, array( 'participantId' => KINDGI_TEST_JANE ) );
	kindgi_test_answer(
		200,
		array(
			'data'    => array(
				array(
					'sequence' => 1,
					'role'     => 'user',
					'content'  => kindgi_test_mail_turn(),
				),
				array(
					'sequence' => 2,
					'role'     => 'user',
					'content'  => 'And order 28?',
				),
			),
			'hasMore' => false,
		)
	);
	$answer = Kindgi_Rest::messages( new WP_REST_Request( array( 'id' => 'c-mail' ) ) );
	kindgi_assert_same( 'Order 27 - can it ship before Friday?', $answer['messages'][0]['mail']['subject'], 'the turn mail started, as its thread' );
	kindgi_assert_same( kindgi_test_mail_turn(), $answer['messages'][0]['text'], 'its text as the agent was given it' );
	kindgi_assert_same( null, $answer['messages'][1]['mail'], "a person's words are only words" );
}
