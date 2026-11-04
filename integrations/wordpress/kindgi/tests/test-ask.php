<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The site's project, as Jane's session names it (`kindgi_test_answer_session()`). */
const KINDGI_TEST_SITE_PROJECT = '5a2f0c3e-8d91-4b7a-a6e2-91c4d3b0f817';

/** A step of the run that completed, with what it gave, as Kindgi's journal has it. */
function kindgi_test_completed( int $sequence, string $node, array $output ): array {
	return array(
		'sequence'  => $sequence,
		'kind'      => 'step.completed',
		'nodeId'    => $node,
		'timestamp' => sprintf( '2026-11-04T09:00:%02dZ', $sequence ),
		'payload'   => array( 'output' => $output ),
	);
}

/** The model's reply in a round: it asks for two tools. */
function kindgi_test_reply(): array {
	return array(
		'role'      => 'assistant',
		'content'   => '',
		'toolCalls' => array(
			array(
				'id'        => 'call-1',
				'name'      => 'woo.find-orders',
				'arguments' => array( 'status' => 'processing' ),
			),
			array(
				'id'        => 'call-2',
				'name'      => 'acme.reply',
				'arguments' => array( 'orderId' => 18 ),
			),
		),
	);
}

/** A tool's answer as the conversation keeps it. */
function kindgi_test_tool_message( int $sequence, string $call, string $tool, array $result, string $at = '2026-11-04T09:00:03Z' ): array {
	return array(
		'sequence'  => $sequence,
		'role'      => 'tool',
		'content'   => $result,
		'toolCall'  => array(
			'toolId'       => $tool,
			'invocationId' => $call,
		),
		'createdAt' => $at,
	);
}

/** What the round's first call answered. */
const KINDGI_TEST_ORDERS = array( 'orders' => array( array( 'id' => 18 ) ) );

/** What the round's second call answered: its approval was rejected. */
const KINDGI_TEST_REJECTED = array(
	'status'    => 'rejected',
	'rationale' => 'Not before the customer answers.',
);

/**
 * One round of the agent's loop, from sequence 2: it asks for two tools,
 * one runs and the other's approval is rejected. Each of the round's three
 * steps carries the model's reply; the tool step and the budget check also
 * carry what the round added to the conversation.
 */
function kindgi_test_round( string $node_prefix = '' ): array {
	$reply    = array(
		'finishReason' => 'tool-use',
		'message'      => kindgi_test_reply(),
	);
	$appended = array(
		'iterationAppended' => array(
			array(
				'sequence' => 4,
				'role'     => 'assistant',
				'content'  => array( 'toolCalls' => kindgi_test_reply()['toolCalls'] ),
			),
			kindgi_test_tool_message( 5, 'call-1', 'woo.find-orders', KINDGI_TEST_ORDERS ),
			kindgi_test_tool_message( 6, 'call-2', 'acme.reply', KINDGI_TEST_REJECTED ),
		),
	);
	return array(
		kindgi_test_completed( 2, $node_prefix . 'model-call', $reply ),
		kindgi_test_completed( 3, $node_prefix . 'dispatch-tools', $reply + $appended ),
		kindgi_test_completed( 4, $node_prefix . 'budget-check', $reply + $appended ),
	);
}

/** Jane's turn r-1 polled from `since`: Kindgi answers the run, then its journal (and more, if queued). */
function kindgi_test_poll( array $run, array $journal, int $since = 0 ) {
	kindgi_test_answer( 200, kindgi_test_run( $run ) );
	kindgi_test_answer( 200, array( 'data' => $journal ) );
	return Kindgi_Rest::run(
		new WP_REST_Request(
			array(
				'id'    => 'r-1',
				'since' => $since,
			)
		)
	);
}

function test_ask_a_running_turn_lists_each_call_once_with_its_answer_when_it_comes(): void {
	kindgi_test_jane_at_work();
	$started = array(
		'sequence' => 1,
		'kind'     => 'run.started',
	);
	$final   = kindgi_test_completed( 5, 'persist-final-message', array( 'message' => array( 'toolCalls' => array( array( 'id' => 'call-9', 'name' => 'acme.other' ) ) ) ) );
	$turn    = kindgi_test_poll( array( 'status' => 'running' ), array_merge( array( $started ), kindgi_test_round(), array( $final ) ) );
	kindgi_assert_same(
		array(
			array(
				'callId' => 'call-1',
				'toolId' => 'woo.find-orders',
				'at'     => '2026-11-04T09:00:02Z',
			),
			array(
				'callId' => 'call-2',
				'toolId' => 'acme.reply',
				'at'     => '2026-11-04T09:00:02Z',
			),
		),
		$turn['steps'],
		"each call once, from its model call, though the loop's later steps carry the same reply"
	);
	kindgi_assert_same(
		array(
			array(
				'callId' => 'call-1',
				'toolId' => 'woo.find-orders',
				'result' => KINDGI_TEST_ORDERS,
			),
			array(
				'callId' => 'call-2',
				'toolId' => 'acme.reply',
				'result' => KINDGI_TEST_REJECTED,
			),
		),
		$turn['answers'],
		"each call's answer once, from the tool step, as the conversation keeps it"
	);
	kindgi_assert_same( 5, $turn['since'], 'the next poll asks for what came after the last entry' );
	kindgi_assert_same( 2, count( $GLOBALS['kindgi_test']['requests'] ), 'the run and its journal: a running turn never asks more' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][1][0], '/v1/runs/r-1/journal?since=0' ), 'its journal from the start' );

	kindgi_test_jane_at_work();
	$nested = kindgi_test_poll( array( 'status' => 'running' ), kindgi_test_round( 'answer/' ) );
	kindgi_assert_same( array( 'call-1', 'call-2' ), array_column( $nested['steps'], 'callId' ), "a turn inside a flow: its loop's steps under the flow step's id" );
	kindgi_assert_same( array( 'call-1', 'call-2' ), array_column( $nested['answers'], 'callId' ), 'and their answers' );
}

function test_ask_a_later_poll_brings_the_answers_to_calls_it_already_listed(): void {
	kindgi_test_jane_at_work();
	$turn = kindgi_test_poll( array( 'status' => 'running' ), array_slice( kindgi_test_round(), 1 ), 2 );
	kindgi_assert_same( array(), $turn['steps'], 'no call again: the poll before listed them' );
	kindgi_assert_same( array( 'call-1', 'call-2' ), array_column( $turn['answers'], 'callId' ), 'and their answers, for the browser to put in their place' );
	kindgi_assert_same( 4, $turn['since'], 'after the last entry' );
}

function test_ask_calls_that_never_run_say_so_or_are_never_listed(): void {
	kindgi_test_jane_at_work();
	$reply = array(
		'finishReason' => 'tool-use',
		'message'      => kindgi_test_reply(),
	);
	$why   = "This call didn't run: the reply that asked for it didn't pass this guardrail: tone.";
	$back  = kindgi_test_completed(
		3,
		'dispatch-tools',
		$reply + array(
			'iterationAppended' => array(),
			'nextMessages'      => array(
				array(
					'role'    => 'user',
					'content' => 'Which orders are still processing?',
				),
				kindgi_test_reply(),
				array(
					'role'       => 'tool',
					'toolCallId' => 'call-1',
					'content'    => json_encode(
						array(
							'status' => 'denied',
							'reason' => $why,
						)
					),
				),
				array(
					'role'       => 'tool',
					'toolCallId' => 'call-2',
					'content'    => json_encode(
						array(
							'status' => 'denied',
							'reason' => $why,
						)
					),
				),
			),
		)
	);
	$turn  = kindgi_test_poll( array( 'status' => 'running' ), array( kindgi_test_completed( 2, 'model-call', $reply ), $back ) );
	kindgi_assert_same( array( 'call-1', 'call-2' ), array_column( $turn['steps'], 'callId' ), 'a reply guardrails send back: its calls were asked for' );
	kindgi_assert_same(
		array(
			'callId' => 'call-1',
			'toolId' => 'woo.find-orders',
			'result' => array(
				'status' => 'denied',
				'reason' => $why,
			),
		),
		$turn['answers'][0],
		"and each says it didn't run, as the loop told the model"
	);
	kindgi_assert_same( 2, count( $turn['answers'] ), 'both of them' );

	kindgi_test_jane_at_work();
	$length = array(
		'finishReason' => 'length',
		'message'      => kindgi_test_reply(),
	);
	$cut    = kindgi_test_poll( array( 'status' => 'running' ), array( kindgi_test_completed( 2, 'model-call', $length ), kindgi_test_completed( 3, 'dispatch-tools', $length + array( 'iterationAppended' => array() ) ) ) );
	kindgi_assert_same( array(), $cut['steps'], "a reply that didn't end asking for tools: none of its calls runs, so none is listed" );
	kindgi_assert_same( array(), $cut['answers'], 'and none is answered' );
}

function test_ask_a_turn_that_waits_or_failed_takes_its_calls_answers_from_the_conversation(): void {
	kindgi_test_jane_at_work();
	$waiting = array(
		'status'    => 'suspended',
		'createdAt' => '2026-11-04T09:00:00Z',
	);
	kindgi_test_answer( 200, kindgi_test_run( $waiting ) );
	kindgi_test_answer( 200, array( 'data' => array( kindgi_test_round()[0] ) ) );
	kindgi_test_answer(
		200,
		array(
			'data'    => array(
				kindgi_test_tool_message( 1, 'call-0', 'woo.find-orders', array( 'orders' => array() ), '2026-11-03T17:00:00Z' ),
				kindgi_test_tool_message( 5, 'call-1', 'woo.find-orders', KINDGI_TEST_ORDERS ),
			),
			'hasMore' => false,
		)
	);
	$turn = Kindgi_Rest::run(
		new WP_REST_Request(
			array(
				'id'    => 'r-1',
				'since' => 0,
			)
		)
	);
	kindgi_assert_same( array( 'call-1', 'call-2' ), array_column( $turn['steps'], 'callId' ), 'both calls, from the model call' );
	kindgi_assert_same(
		array(
			array(
				'callId' => 'call-1',
				'toolId' => 'woo.find-orders',
				'result' => KINDGI_TEST_ORDERS,
			),
		),
		$turn['answers'],
		"while call-2 waits for a person, call-1's answer, kept in the conversation since the turn started, and no earlier turn's"
	);
	kindgi_assert_same( 3, count( $GLOBALS['kindgi_test']['requests'] ), 'the run, its journal, then its conversation' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][2][0], '/v1/conversations/c-1/messages' ), "the turn's own conversation" );

	kindgi_test_jane_at_work();
	kindgi_test_answer( 200, kindgi_test_run( array( 'status' => 'failed' ) + $waiting ) );
	kindgi_test_answer(
		200,
		array(
			'data' => array(
				kindgi_test_round()[0],
				array(
					'sequence' => 3,
					'kind'     => 'step.failed',
					'nodeId'   => 'dispatch-tools',
					'payload'  => array( 'message' => 'The order service is down.' ),
				),
			),
		)
	);
	kindgi_test_answer(
		200,
		array(
			'data'    => array( kindgi_test_tool_message( 5, 'call-1', 'woo.find-orders', KINDGI_TEST_ORDERS ) ),
			'hasMore' => false,
		)
	);
	$failed = Kindgi_Rest::run(
		new WP_REST_Request(
			array(
				'id'    => 'r-1',
				'since' => 0,
			)
		)
	);
	kindgi_assert_same( array( 'call-1' ), array_column( $failed['answers'], 'callId' ), 'a step that failed journals no answers: the one that ran is read from the conversation' );
}

function test_ask_someone_elses_turn_shows_nothing_of_its_journal(): void {
	kindgi_test_jane_at_work();
	kindgi_test_answer( 200, kindgi_test_run( array( 'actsFor' => 'user:8f0b2c1d-5e6a-4f7b-9c8d-0a1b2c3d4e5f' ) ) );
	$turn = Kindgi_Rest::run(
		new WP_REST_Request(
			array(
				'id'    => 'r-1',
				'since' => 0,
			)
		)
	);
	kindgi_assert_same( 'kindgi_run_not_found', $turn->get_error_code(), "a turn she didn't send here is none of hers" );
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['requests'] ), 'and its journal is never asked for' );
}

/** Jane opens a conversation with an agent whose version Kindgi answers with this project. */
function kindgi_test_open_with( $project, string $title = 'Order 18' ) {
	kindgi_test_jane_at_work();
	kindgi_test_answer(
		200,
		array(
			'agentId'   => 'acme-desk.store-agent',
			'version'   => '1.2.0',
			'projectId' => $project,
		)
	);
	kindgi_test_answer(
		201,
		array(
			'id'           => 'c-1',
			'title'        => 'Order 18',
			'agentId'      => 'acme-desk.store-agent',
			'agentVersion' => '1.2.0',
			'status'       => 'open',
			'openedAt'     => '2026-11-04T09:00:00Z',
		)
	);
	return Kindgi_Rest::open_conversation(
		new WP_REST_Request(
			array(
				'agentId'      => 'acme-desk.store-agent',
				'agentVersion' => '1.2.0',
				'title'        => $title,
			)
		)
	);
}

/** What the `$index`-th call to Kindgi sent, as JSON. */
function kindgi_test_posted( int $index ): array {
	return json_decode( $GLOBALS['kindgi_test']['requests'][ $index ][1]['body'], true );
}

function test_ask_a_new_conversation_names_the_sites_project_only_for_an_agent_shared_from_another(): void {
	$opened = kindgi_test_open_with( KINDGI_TEST_SITE_PROJECT );
	kindgi_assert_same( 'c-1', $opened['id'], 'the new conversation' );
	kindgi_assert_same( 2, count( $GLOBALS['kindgi_test']['requests'] ), "the agent's version, then the conversation" );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][0][0], '/v1/agents/acme-desk.store-agent/versions/1.2.0' ), 'the version she picked, read as her' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][1][0], '/v1/conversations' ), 'then the conversation' );
	$own = kindgi_test_posted( 1 );
	kindgi_assert( ! array_key_exists( 'projectId', $own ), "the site's own agent: no project named" );
	kindgi_assert_same( KINDGI_TEST_JANE, $own['participantId'], "kept per person: Jane, as her session names her" );
	kindgi_assert_same( 'Order 18', $own['title'], 'with her title' );

	kindgi_test_open_with( 'p-agency' );
	kindgi_assert_same( KINDGI_TEST_SITE_PROJECT, kindgi_test_posted( 1 )['projectId'], "an agent shared from another project: the site's project, where the conversation belongs" );

	kindgi_test_open_with( null );
	kindgi_assert( ! array_key_exists( 'projectId', kindgi_test_posted( 1 ) ), 'an agent in no project: none named' );

	kindgi_test_open_with( KINDGI_TEST_SITE_PROJECT, '  Order 18  ' );
	kindgi_assert_same( 'Order 18', kindgi_test_posted( 1 )['title'], 'a title trimmed' );
	kindgi_test_open_with( KINDGI_TEST_SITE_PROJECT, '   ' );
	kindgi_assert_same( 'From WordPress', kindgi_test_posted( 1 )['title'], 'a blank one: where it came from' );
}

function test_ask_no_conversation_opens_when_the_agents_version_cant_be_read_and_kindgis_refusal_comes_back(): void {
	kindgi_test_jane_at_work();
	kindgi_test_answer(
		404,
		array(
			'error' => array(
				'code'    => 'not-found',
				'message' => 'No such agent version.',
			),
		)
	);
	$opened = Kindgi_Rest::open_conversation(
		new WP_REST_Request(
			array(
				'agentId'      => 'acme-desk.store-agent',
				'agentVersion' => '9.9.9',
				'title'        => '',
			)
		)
	);
	kindgi_assert( is_wp_error( $opened ), "the version's error comes back" );
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['requests'] ), 'and nothing is posted' );

	kindgi_test_jane_at_work();
	kindgi_test_answer(
		200,
		array(
			'agentId'   => 'acme-desk.store-agent',
			'version'   => '1.2.0',
			'projectId' => KINDGI_TEST_SITE_PROJECT,
		)
	);
	kindgi_test_answer(
		403,
		array(
			'error' => array(
				'code'    => 'forbidden',
				'message' => 'You may not talk to this agent.',
			),
		)
	);
	$refused = Kindgi_Rest::open_conversation(
		new WP_REST_Request(
			array(
				'agentId'      => 'acme-desk.store-agent',
				'agentVersion' => '1.2.0',
				'title'        => 'Order 18',
			)
		)
	);
	kindgi_assert( is_wp_error( $refused ), "Kindgi's refusal of the conversation comes back" );
	kindgi_assert_same( 2, count( $GLOBALS['kindgi_test']['requests'] ), 'after the one post' );
}
