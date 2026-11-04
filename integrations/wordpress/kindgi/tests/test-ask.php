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

/**
 * One round of the agent's loop, from sequence 2: it asks for two tools,
 * one runs and the other's approval is rejected. Each of the round's three
 * steps carries the model's message; the tool step and the budget check
 * also carry what the round added to the conversation.
 */
function kindgi_test_round(): array {
	$message  = array(
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
	$appended = array(
		array(
			'sequence' => 4,
			'role'     => 'assistant',
			'content'  => array( 'toolCalls' => $message['toolCalls'] ),
		),
		array(
			'sequence' => 5,
			'role'     => 'tool',
			'content'  => array( 'orders' => array( array( 'id' => 18 ) ) ),
			'toolCall' => array(
				'toolId'       => 'woo.find-orders',
				'invocationId' => 'call-1',
			),
		),
		array(
			'sequence' => 6,
			'role'     => 'tool',
			'content'  => array(
				'status'    => 'rejected',
				'rationale' => 'Not before the customer answers.',
			),
			'toolCall' => array(
				'toolId'       => 'acme.reply',
				'invocationId' => 'call-2',
			),
		),
	);
	return array(
		kindgi_test_completed( 2, 'model-call', array( 'message' => $message ) ),
		kindgi_test_completed(
			3,
			'dispatch-tools',
			array(
				'message'           => $message,
				'iterationAppended' => $appended,
			)
		),
		kindgi_test_completed(
			4,
			'budget-check',
			array(
				'message'           => $message,
				'iterationAppended' => $appended,
			)
		),
	);
}

function test_ask_a_running_turn_lists_each_call_once_with_its_answer_when_it_comes(): void {
	kindgi_test_jane_at_work();
	kindgi_test_answer( 200, kindgi_test_run( array( 'status' => 'running' ) ) );
	kindgi_test_answer(
		200,
		array(
			'data' => array_merge(
				array(
					array(
						'sequence' => 1,
						'kind'     => 'run.started',
					),
				),
				kindgi_test_round(),
				array( kindgi_test_completed( 5, 'persist-final-message', array( 'message' => array( 'toolCalls' => array( array( 'id' => 'call-9', 'name' => 'acme.other' ) ) ) ) ) )
			),
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
		"each call once, from its model call, though the loop's later steps carry the same message"
	);
	kindgi_assert_same(
		array(
			array(
				'callId' => 'call-1',
				'toolId' => 'woo.find-orders',
				'result' => array( 'orders' => array( array( 'id' => 18 ) ) ),
			),
			array(
				'callId' => 'call-2',
				'toolId' => 'acme.reply',
				'result' => array(
					'status'    => 'rejected',
					'rationale' => 'Not before the customer answers.',
				),
			),
		),
		$turn['answers'],
		"each call's answer once, from the tool step, as the conversation keeps it"
	);
	kindgi_assert_same( 5, $turn['since'], 'the next poll asks for what came after the last entry' );
	kindgi_assert_same( 2, count( $GLOBALS['kindgi_test']['requests'] ), 'the run and its journal, nothing more' );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][1][0], '/v1/runs/r-1/journal?since=0' ), 'its journal from the start' );
}

function test_ask_a_later_poll_brings_the_answers_to_calls_it_already_listed(): void {
	kindgi_test_jane_at_work();
	kindgi_test_answer( 200, kindgi_test_run( array( 'status' => 'running' ) ) );
	kindgi_test_answer( 200, array( 'data' => array_slice( kindgi_test_round(), 1 ) ) );
	$turn = Kindgi_Rest::run(
		new WP_REST_Request(
			array(
				'id'    => 'r-1',
				'since' => 2,
			)
		)
	);
	kindgi_assert_same( array(), $turn['steps'], 'no call again: the poll before listed them' );
	kindgi_assert_same( array( 'call-1', 'call-2' ), array_column( $turn['answers'], 'callId' ), 'and their answers, for the browser to put in their place' );
	kindgi_assert_same( 4, $turn['since'], 'after the last entry' );
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
function kindgi_test_open_with( $project ) {
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
				'title'        => 'Order 18',
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
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][0][0], '/v1/agents/acme-desk.store-agent/versions/1.2.0' ), "the version she picked, read as her" );
	kindgi_assert( false !== strpos( $GLOBALS['kindgi_test']['requests'][1][0], '/v1/conversations' ), 'then the conversation' );
	$own = kindgi_test_posted( 1 );
	kindgi_assert( ! array_key_exists( 'projectId', $own ), "the site's own agent: no project named" );
	kindgi_assert_same( KINDGI_TEST_JANE, $own['participantId'], 'kept per person: Jane' );
	kindgi_assert_same( 'Order 18', $own['title'], 'with her title' );

	kindgi_test_open_with( 'p-agency' );
	kindgi_assert_same( KINDGI_TEST_SITE_PROJECT, kindgi_test_posted( 1 )['projectId'], "an agent shared from another project: the site's project, where the conversation belongs" );

	kindgi_test_open_with( null );
	kindgi_assert( ! array_key_exists( 'projectId', kindgi_test_posted( 1 ) ), 'an agent in no project: none named' );
}

function test_ask_no_conversation_opens_when_the_agents_version_cant_be_read(): void {
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
}
