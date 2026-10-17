<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A user of the site, as WordPress has them. */
function kindgi_test_user( int $id, string $name, array $roles ): WP_User {
	$user                                     = new WP_User( $id, $name, $roles, strtolower( $name ) . '@acme-store.example' );
	$GLOBALS['kindgi_test']['users'][ $id ] = $user;
	return $user;
}

/** Kindgi's next answer: a status and a JSON body. */
function kindgi_test_answer( int $status, array $body ): void {
	$GLOBALS['kindgi_test']['answers'][] = array(
		'response' => array( 'code' => $status ),
		'body'     => json_encode( $body ),
		'headers'  => array(),
	);
}

/** Kindgi takes the statement: a session for the person. */
function kindgi_test_answer_session(): void {
	kindgi_test_answer(
		200,
		array(
			'token'     => 'kgi_test_session',
			'expiresAt' => gmdate( 'c', time() + 900 ),
			'userId'    => '3726b1e7-4c1e-4b6a-9d84-0b172f5e8d9c',
			'actor'     => 'user:3726b1e7-4c1e-4b6a-9d84-0b172f5e8d9c',
			'projectId' => '5a2f0c3e-8d91-4b7a-a6e2-91c4d3b0f817',
		)
	);
}

/** Kindgi refuses the statement, for this reason. */
function kindgi_test_answer_refused( string $reason, string $message ): void {
	kindgi_test_answer(
		401,
		array(
			'error' => array(
				'code'      => 'site-sign-in-refused',
				'message'   => $message,
				'details'   => array( 'reason' => $reason ),
				'requestId' => 'req-acme',
			),
		)
	);
}

/** The claims of the statement in the `$index`-th call to Kindgi. */
function kindgi_test_sent( int $index ): array {
	$body = json_decode( $GLOBALS['kindgi_test']['requests'][ $index ][1]['body'], true );
	return kindgi_test_part( $body['statement'], 1 );
}

/** An enrolled site, its Kindgi URL set, and Jane (a shop manager) whom Kindgi knows. */
function kindgi_test_jane_known(): WP_User {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	update_option( Kindgi_Settings::URL_OPTION, 'https://kindgi.acme.example' );
	$jane = kindgi_test_user( 7, 'Jane', array( 'shop_manager' ) );
	kindgi_test_answer_session();
	kindgi_assert( ! is_wp_error( Kindgi_Sessions::sign_in( $jane ) ), 'Jane signs in' );
	return $jane;
}

function kindgi_test_people(): array {
	return get_option( Kindgi_People::OPTION, array() );
}

const KINDGI_TEST_REMOVED = "This person was removed: their site can't sign them in again";

function test_people_kindgi_knows_only_whom_it_accepted(): void {
	$jane    = kindgi_test_jane_known();
	$subject = Kindgi_Sessions::subject_of( $jane->ID );
	kindgi_assert_same(
		array(
			$subject => array(
				'user'  => 7,
				'roles' => array( 'shop_manager' ),
			),
		),
		kindgi_test_people(),
		'Jane, with her roles'
	);
	$ed = kindgi_test_user( 9, 'Ed', array( 'editor' ) );
	kindgi_test_answer_refused( 'role-not-allowed', 'None of these roles may sign in through this site' );
	kindgi_assert( is_wp_error( Kindgi_Sessions::sign_in( $ed ) ), 'Ed is refused' );
	kindgi_assert_same( array( $subject ), array_keys( kindgi_test_people() ), 'never Ed' );
	// Ed leaves: Kindgi never knew him, so it's told nothing.
	$calls = count( $GLOBALS['kindgi_test']['requests'] );
	Kindgi_People::left( $ed->ID );
	kindgi_assert_same( $calls, count( $GLOBALS['kindgi_test']['requests'] ), 'no call for Ed' );
}

function test_people_a_deleted_user_is_told_to_kindgi_as_left_for_good(): void {
	$jane    = kindgi_test_jane_known();
	$subject = Kindgi_Sessions::subject_of( $jane->ID );
	kindgi_test_answer_refused( 'person-removed', KINDGI_TEST_REMOVED );
	Kindgi_People::left( $jane->ID );
	$sent = kindgi_test_sent( 1 );
	kindgi_assert_same( $subject, $sent['sub'], 'about Jane' );
	kindgi_assert_same( true, $sent['removed'] ?? null, 'saying she left' );
	kindgi_assert_same( array(), $sent['roles'], 'with no roles' );
	kindgi_assert_same( array(), kindgi_test_people(), 'Kindgi took it: nothing more to tell' );
	foreach ( array( Kindgi_Sessions::SUBJECT, Kindgi_Sessions::USER_ID, Kindgi_Sessions::SESSION ) as $key ) {
		kindgi_assert( false === get_user_option( $key, $jane->ID ), "her $key is gone here" );
	}
}

function test_people_a_change_kindgi_didnt_get_waits_and_is_tried_again_never_dropped(): void {
	$jane    = kindgi_test_jane_known();
	$subject = Kindgi_Sessions::subject_of( $jane->ID );
	Kindgi_People::left( $jane->ID ); // Kindgi can't be reached.
	$waiting = kindgi_test_people()[ $subject ];
	kindgi_assert_same( 1, $waiting['tries'], 'one try' );
	kindgi_assert_same( true, $waiting['left'], 'that she left' );
	kindgi_assert( false !== strpos( $waiting['error'], "couldn't be reached" ), 'why: ' . $waiting['error'] );
	kindgi_assert( $waiting['due'] >= time() + Kindgi_People::RETRY_FIRST - 1, 'later' );
	kindgi_assert( wp_next_scheduled( Kindgi_People::RETRY ) <= $waiting['due'], 'a wp-cron run comes by then' );
	$listed = Kindgi_People::waiting();
	kindgi_assert_same( 1, count( $listed ), 'the settings page lists it' );
	kindgi_assert_same( true, $listed[0]['left'], 'as someone who left' );

	// Many more failures: it backs off, and stays.
	for ( $i = 0; $i < 12; $i++ ) {
		$people                       = kindgi_test_people();
		$people[ $subject ]['due']    = time() - 1;
		update_option( Kindgi_People::OPTION, $people );
		Kindgi_People::retry();
	}
	$waiting = kindgi_test_people()[ $subject ];
	kindgi_assert_same( 13, $waiting['tries'], 'every try counted' );
	kindgi_assert( $waiting['due'] <= time() + Kindgi_People::RETRY_MAX, 'never longer than the longest delay' );

	// Kindgi is back.
	$people                    = kindgi_test_people();
	$people[ $subject ]['due'] = time() - 1;
	update_option( Kindgi_People::OPTION, $people );
	kindgi_test_answer_refused( 'person-removed', KINDGI_TEST_REMOVED );
	Kindgi_People::retry();
	kindgi_assert_same( array(), kindgi_test_people(), 'told at last' );
	kindgi_assert_same( true, kindgi_test_sent( count( $GLOBALS['kindgi_test']['requests'] ) - 1 )['removed'] ?? null, 'that she left' );
}

function test_people_while_kindgi_is_unreachable_the_next_ones_wait_without_a_call(): void {
	kindgi_test_jane_known();
	$ada = kindgi_test_user( 8, 'Ada', array( 'administrator' ) );
	kindgi_test_answer_session();
	Kindgi_Sessions::sign_in( $ada );
	$calls = count( $GLOBALS['kindgi_test']['requests'] );
	Kindgi_People::left( 7 ); // Unreachable: one call.
	Kindgi_People::left( 8 ); // Waits for wp-cron: no call.
	kindgi_assert_same( $calls + 1, count( $GLOBALS['kindgi_test']['requests'] ), 'one call, not two timeouts' );
	kindgi_assert_same( 2, count( Kindgi_People::waiting() ), 'both wait' );
}

function test_people_a_changed_role_is_told_once_at_the_end_of_the_request_and_stays_reversible(): void {
	$jane    = kindgi_test_jane_known();
	$subject = Kindgi_Sessions::subject_of( $jane->ID );
	$calls   = count( $GLOBALS['kindgi_test']['requests'] );
	$GLOBALS['kindgi_test']['users'][7]->roles = array( 'customer' );
	Kindgi_People::roles_changed( 7 );
	Kindgi_People::roles_changed( 7 );
	kindgi_assert_same( $calls, count( $GLOBALS['kindgi_test']['requests'] ), 'nothing sent yet' );
	kindgi_assert_same( 1, count( $GLOBALS['kindgi_test']['actions']['shutdown'] ?? array() ), 'once, at the end' );
	kindgi_assert( false === get_user_option( Kindgi_Sessions::SESSION, 7 ), 'her kept session is forgotten' );
	kindgi_assert( false !== wp_next_scheduled( Kindgi_People::RETRY ) && wp_next_scheduled( Kindgi_People::RETRY ) <= time() + 60, 'should the request end first, wp-cron sends it' );

	kindgi_test_answer_refused( 'role-not-allowed', 'None of these roles may sign in through this site' );
	Kindgi_People::tell_changed();
	kindgi_assert_same( $calls + 1, count( $GLOBALS['kindgi_test']['requests'] ), 'one statement' );
	$sent = kindgi_test_sent( $calls );
	kindgi_assert_same( array( 'customer' ), $sent['roles'], 'with her roles now' );
	kindgi_assert( ! array_key_exists( 'removed', $sent ), 'not that she left' );
	kindgi_assert_same( 'Jane', $sent['name'], 'with her name' );
	kindgi_assert_same(
		array(
			'user'  => 7,
			'roles' => array( 'customer' ),
		),
		kindgi_test_people()[ $subject ],
		'still known, with the roles Kindgi has: the same subject comes back with her roles'
	);
	kindgi_assert_same( $subject, Kindgi_Sessions::subject_of( 7 ), 'the same subject' );
}

function test_people_the_daily_check_finds_what_no_hook_saw(): void {
	$jane = kindgi_test_jane_known();
	$ada  = kindgi_test_user( 8, 'Ada', array( 'administrator' ) );
	kindgi_test_answer_session();
	Kindgi_Sessions::sign_in( $ada );
	$bob = kindgi_test_user( 10, 'Bob', array( 'shop_manager' ) );
	kindgi_test_answer_session();
	Kindgi_Sessions::sign_in( $bob );
	$ada_subject = Kindgi_Sessions::subject_of( 8 );
	$calls       = count( $GLOBALS['kindgi_test']['requests'] );

	// Behind the hooks' backs: Jane's role changed in the database, Ada's user deleted by hand.
	$GLOBALS['kindgi_test']['users'][7]->roles = array( 'administrator' );
	unset( $GLOBALS['kindgi_test']['users'][8] );
	kindgi_test_answer_session();
	kindgi_test_answer_refused( 'person-removed', KINDGI_TEST_REMOVED );
	Kindgi_People::check();

	kindgi_assert_same( $calls + 2, count( $GLOBALS['kindgi_test']['requests'] ), 'Jane and Ada; Bob is as Kindgi has him' );
	kindgi_assert_same( array( 'administrator' ), kindgi_test_sent( $calls )['roles'], "Jane's roles now" );
	kindgi_assert_same( true, kindgi_test_sent( $calls + 1 )['removed'] ?? null, 'Ada left' );
	kindgi_assert_same( $ada_subject, kindgi_test_sent( $calls + 1 )['sub'], 'about Ada' );
	$people = kindgi_test_people();
	kindgi_assert_same( array( 'administrator' ), $people[ Kindgi_Sessions::subject_of( 7 ) ]['roles'], 'Jane, as Kindgi has her now' );
	kindgi_assert( ! isset( $people[ $ada_subject ] ), 'Ada, told' );
}

function test_people_erasing_a_person_tells_kindgi_they_left(): void {
	$jane = kindgi_test_jane_known();
	kindgi_test_answer_refused( 'person-removed', KINDGI_TEST_REMOVED );
	$erased = Kindgi_Admin::erase( 'jane@acme-store.example' );
	kindgi_assert_same( true, $erased['items_removed'], 'something of hers was here' );
	kindgi_assert_same( true, $erased['items_retained'], 'Kindgi keeps its record of her' );
	kindgi_assert_same( true, kindgi_test_sent( 1 )['removed'] ?? null, 'Kindgi is told she left' );
	kindgi_assert( null === Kindgi_Sessions::subject_of( $jane->ID ), 'her subject is gone' );
	kindgi_assert_same( array(), kindgi_test_people(), 'nothing more to tell' );
}

function test_people_erasing_someone_kindgi_never_knew_retains_nothing(): void {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	update_option( Kindgi_Settings::URL_OPTION, 'https://kindgi.acme.example' );
	$ed = kindgi_test_user( 9, 'Ed', array( 'editor' ) );
	kindgi_test_answer_refused( 'role-not-allowed', 'None of these roles may sign in through this site' );
	Kindgi_Sessions::sign_in( $ed );
	$erased = Kindgi_Admin::erase( 'ed@acme-store.example' );
	kindgi_assert_same( true, $erased['items_removed'], 'his subject was here' );
	kindgi_assert_same( false, $erased['items_retained'], 'Kindgi never had him' );
	kindgi_assert_same( array(), $erased['messages'], 'nothing to say about Kindgi' );
}

function test_people_erasing_while_kindgi_is_unreachable_retains_the_waiting_statement(): void {
	$jane   = kindgi_test_jane_known();
	$erased = Kindgi_Admin::erase( 'jane@acme-store.example' ); // Kindgi can't be reached.
	kindgi_assert_same( true, $erased['items_retained'], 'retained' );
	kindgi_assert( Kindgi_People::waiting_for( $jane->ID ), 'her statement waits' );
}

function test_people_a_request_sends_at_most_a_runs_worth_and_wp_cron_the_rest(): void {
	kindgi_test_enrolled( Kindgi_Keys::generate() );
	update_option( Kindgi_Settings::URL_OPTION, 'https://kindgi.acme.example' );
	$count = Kindgi_People::PER_RUN + 2;
	for ( $id = 100; $id < 100 + $count; $id++ ) {
		$user = kindgi_test_user( $id, "Staff $id", array( 'shop_manager' ) );
		kindgi_test_answer_session();
		Kindgi_Sessions::sign_in( $user );
	}
	$calls = count( $GLOBALS['kindgi_test']['requests'] );
	// A bulk delete: every one of them, in one request.
	for ( $id = 100; $id < 100 + $count; $id++ ) {
		kindgi_test_answer_refused( 'person-removed', KINDGI_TEST_REMOVED );
	}
	for ( $id = 100; $id < 100 + $count; $id++ ) {
		Kindgi_People::left( $id );
	}
	kindgi_assert_same( $calls + Kindgi_People::PER_RUN, count( $GLOBALS['kindgi_test']['requests'] ), "a run's worth now" );
	kindgi_assert_same( 2, count( Kindgi_People::waiting() ), 'the rest wait' );
	kindgi_assert( wp_next_scheduled( Kindgi_People::RETRY ) <= time() + 60, 'for wp-cron, soon' );
	// The wp-cron run: a request of its own.
	kindgi_test_reset_request();
	Kindgi_People::retry();
	kindgi_assert_same( array(), Kindgi_People::waiting(), 'all told' );
}

function test_people_a_wp_cron_run_schedules_the_next_one_for_whatever_still_waits(): void {
	$jane = kindgi_test_jane_known();
	Kindgi_People::left( $jane->ID ); // Kindgi can't be reached: due in 5 minutes.
	$due = Kindgi_People::waiting()[0]['due'];
	// The run the request scheduled comes before that, finds nothing due yet, and schedules the next.
	unset( $GLOBALS['kindgi_test']['cron'][ Kindgi_People::RETRY ] );
	kindgi_test_reset_request();
	Kindgi_People::retry();
	kindgi_assert_same( $due, wp_next_scheduled( Kindgi_People::RETRY ), 'the next run, when it is due' );
}
