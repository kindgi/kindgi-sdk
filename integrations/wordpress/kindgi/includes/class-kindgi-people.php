<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Keeps Kindgi up to date about the people it knows from this site.
 *
 * Kindgi hears about a person only through a statement, and someone who
 * can't open the Kindgi pages any more never sends one. So the site sends it
 * for them:
 *
 * - **When their roles change,** a statement with their roles now. Kindgi
 *   gives what those roles give, or, when none may sign in, ends their
 *   grants, reviewer role and sessions. That's reversible: the same roles
 *   back bring the same person back.
 * - **When they leave the site** (their user deleted, removed from it, or
 *   erased), a statement saying so (`removed`). Kindgi takes that as for
 *   good: it ends the same, and refuses them from then on. Their subject
 *   here goes too, so if they come back, they're a new person.
 *
 * The people Kindgi knows are kept here, by subject (the `kindgi_people`
 * option), since a deleted user's own options go with them. Only someone
 * Kindgi accepted is on it, so nothing here ever makes a new person at
 * Kindgi.
 *
 * A statement that doesn't get through waits, and wp-cron tries it again,
 * less often each time, never giving up; the settings page lists what's
 * waiting. Kindgi finishes a removal it's told about again, so a retry
 * after a failure there completes it. Once a day each person is checked
 * against WordPress, for what no hook saw: a role changed in the database,
 * a user deleted by hand.
 *
 * The list is one option, read and written whole. Two requests at once (a
 * wp-cron run and an administrator's change) can lose one's mark that a
 * statement waits; the daily check finds that change again, so it reaches
 * Kindgi within a day.
 */
final class Kindgi_People {

	/**
	 * The people Kindgi knows, by subject: `user` (their id here) and `roles`
	 * (as Kindgi last had them); while a statement waits, `due`, `tries`,
	 * `error`, and `left` when they left.
	 */
	const OPTION = 'kindgi_people';

	/** wp-cron: the statements whose time has come. */
	const RETRY = 'kindgi_people_retry';

	/** wp-cron: the daily check against WordPress. */
	const CHECK = 'kindgi_people_check';

	/** While Kindgi can't be reached, statements wait for wp-cron instead of each timing out. */
	const UNREACHABLE = 'kindgi_unreachable';

	/**
	 * At most this many statements in one request (a page load, a bulk
	 * delete, a wp-cron run): each waits for Kindgi's answer, and a site's
	 * sign-ins are rate-limited there. The rest wait for wp-cron.
	 */
	const PER_RUN = 30;

	/** The first retry's delay in seconds, doubled each time up to `RETRY_MAX`. */
	const RETRY_FIRST = 300;

	/** The longest delay between two tries, in seconds. */
	const RETRY_MAX = 21600;

	/** Subjects whose roles changed in this request: told once each, at its end. */
	private static $changed = array();

	/** Statements sent in this request, against `PER_RUN`. */
	private static $sent = 0;

	public static function register(): void {
		foreach ( array( 'set_user_role', 'add_user_role', 'remove_user_role' ) as $hook ) {
			add_action( $hook, array( self::class, 'roles_changed' ) );
		}
		add_action( 'delete_user', array( self::class, 'left' ) );
		// Fired with the site switched to, on a multisite network.
		add_action( 'remove_user_from_blog', array( self::class, 'left' ) );
		add_action( self::RETRY, array( self::class, 'retry' ) );
		add_action( self::CHECK, array( self::class, 'check' ) );
		add_action( 'init', array( self::class, 'schedule' ) );
	}

	/** The daily check, scheduled once. */
	public static function schedule(): void {
		if ( false === wp_next_scheduled( self::CHECK ) ) {
			wp_schedule_event( time() + 3600, 'daily', self::CHECK );
		}
	}

	/** On deactivation: no more runs. Activated again, `init` schedules the check again. */
	public static function unschedule(): void {
		wp_clear_scheduled_hook( self::CHECK );
		wp_clear_scheduled_hook( self::RETRY );
	}

	/**
	 * A person's roles changed: their kept session is forgotten and, when
	 * Kindgi knows them, their statement goes at the end of the request, so
	 * several changes at once send one.
	 */
	public static function roles_changed( int $user_id ): void {
		Kindgi_Sessions::forget( $user_id );
		$subject = Kindgi_Sessions::subject_of( $user_id );
		if ( null === $subject || ! self::wait( $subject, false ) ) {
			return;
		}
		if ( array() === self::$changed ) {
			add_action( 'shutdown', array( self::class, 'tell_changed' ) );
		}
		self::$changed[ $subject ] = true;
	}

	/** At the end of a request: the statements for the roles that changed in it. */
	public static function tell_changed(): void {
		$subjects      = array_keys( self::$changed );
		self::$changed = array();
		foreach ( $subjects as $subject ) {
			self::tell( (string) $subject );
		}
	}

	/**
	 * A person left this site: their user is being deleted, removed from it,
	 * or erased. When Kindgi knows them, it's told now. Their subject, Kindgi
	 * id and kept session here go.
	 */
	public static function left( int $user_id ): void {
		$subject = Kindgi_Sessions::subject_of( $user_id );
		if ( null !== $subject && self::wait( $subject, true ) ) {
			self::tell( $subject );
		}
		Kindgi_Sessions::forget( $user_id );
		delete_user_option( $user_id, Kindgi_Sessions::SUBJECT );
		delete_user_option( $user_id, Kindgi_Sessions::USER_ID );
	}

	/** Sends Kindgi the person's statement, and keeps what it answers. */
	public static function tell( string $subject ): void {
		$entry = self::all()[ $subject ] ?? null;
		if ( null === $entry ) {
			return;
		}
		if ( false !== get_transient( self::UNREACHABLE ) ) {
			self::retry_at( time() + self::RETRY_FIRST );
			return;
		}
		if ( self::$sent >= self::PER_RUN ) {
			self::retry_at( time() + 60 );
			return;
		}
		++self::$sent;
		$user   = self::here( $subject, $entry );
		$person = null === $user
			? array(
				'subject' => $subject,
				'name'    => '',
				'roles'   => array(),
				'email'   => '',
				'removed' => true,
			)
			: Kindgi_Sessions::person( $user );
		$answer = Kindgi_Sessions::exchange( $person );
		if ( null !== $user && ! is_wp_error( $answer ) ) {
			Kindgi_Sessions::keep( $user->ID, $answer );
		}
		self::answered( $person, $user, $answer );
	}

	/**
	 * Kindgi's answer to a statement about a person (here, or from their own
	 * sign-in): whom it knows now.
	 *
	 * @param array          $person The statement's person.
	 * @param WP_User|null   $user   Their user; null when they left.
	 * @param array|WP_Error $answer A session, or why not.
	 */
	public static function answered( array $person, ?WP_User $user, $answer ): void {
		$subject = (string) $person['subject'];
		$people  = self::all();
		$reason  = is_wp_error( $answer ) ? ( $answer->get_error_data()['reason'] ?? null ) : null;
		if ( null !== $user && ( ! is_wp_error( $answer ) || ( 'role-not-allowed' === $reason && isset( $people[ $subject ] ) ) ) ) {
			// Kindgi has them with these roles: what they give, or, when none may sign in, nothing for now.
			$people[ $subject ] = array(
				'user'  => $user->ID,
				'roles' => self::sorted( $person['roles'] ),
			);
		} elseif ( null === $user && ( ! is_wp_error( $answer ) || 'person-removed' === $reason || 'role-not-allowed' === $reason ) ) {
			// They left, and Kindgi took it: nothing more to tell it.
			unset( $people[ $subject ] );
		} elseif ( 'person-removed' === $reason ) {
			// Removed at Kindgi: it refuses them from now on.
			unset( $people[ $subject ] );
		} elseif ( is_wp_error( $answer ) && isset( $people[ $subject ]['due'] ) ) {
			// It didn't get through: it waits, and is tried again later.
			if ( 'kindgi_unreachable' === $answer->get_error_code() ) {
				set_transient( self::UNREACHABLE, 1, 60 );
			}
			$tries              = (int) ( $people[ $subject ]['tries'] ?? 0 ) + 1;
			$delay              = (int) min( self::RETRY_MAX, self::RETRY_FIRST * ( 2 ** min( $tries - 1, 10 ) ) );
			$due                = time() + max( $delay, (int) ( $answer->get_error_data()['retryAfter'] ?? 0 ) );
			$people[ $subject ] = array_merge(
				$people[ $subject ],
				array(
					'due'   => $due,
					'tries' => $tries,
					'error' => $answer->get_error_message(),
				)
			);
			self::retry_at( $due );
		}
		self::keep( $people );
	}

	/**
	 * wp-cron: the statements whose time has come, a run's worth at a time;
	 * then the next run, when the soonest one still waiting is due.
	 */
	public static function retry(): void {
		delete_transient( self::UNREACHABLE );
		foreach ( self::all() as $subject => $entry ) {
			if ( self::$sent >= self::PER_RUN ) {
				break;
			}
			if ( isset( $entry['due'] ) && (int) $entry['due'] <= time() ) {
				self::tell( (string) $subject );
			}
		}
		$soonest = null;
		foreach ( self::all() as $entry ) {
			if ( isset( $entry['due'] ) ) {
				$soonest = null === $soonest ? (int) $entry['due'] : min( $soonest, (int) $entry['due'] );
			}
		}
		if ( null !== $soonest ) {
			self::retry_at( max( $soonest, time() + 60 ) );
		}
	}

	/** Whether a statement about this user still waits to reach Kindgi. */
	public static function waiting_for( int $user_id ): bool {
		foreach ( self::all() as $entry ) {
			if ( isset( $entry['due'] ) && (int) ( $entry['user'] ?? 0 ) === $user_id ) {
				return true;
			}
		}
		return false;
	}

	/** wp-cron, daily: whoever changed without a hook seeing it gets their statement. */
	public static function check(): void {
		$people = self::all();
		foreach ( $people as $subject => $entry ) {
			if ( isset( $entry['due'] ) ) {
				continue;
			}
			$user = self::here( (string) $subject, $entry );
			if ( null === $user ) {
				$people[ $subject ]['left'] = true;
				$people[ $subject ]['due']  = time();
			} elseif ( self::sorted( $user->roles ) !== ( $entry['roles'] ?? array() ) ) {
				$people[ $subject ]['due'] = time();
			}
		}
		self::keep( $people );
		self::retry();
	}

	/**
	 * The statements waiting to reach Kindgi, for the settings page.
	 *
	 * @return array<int, array{who: string, left: bool, tries: int, error: string, due: int}>
	 */
	public static function waiting(): array {
		$waiting = array();
		foreach ( self::all() as $entry ) {
			if ( ! isset( $entry['due'] ) ) {
				continue;
			}
			$left      = ! empty( $entry['left'] );
			$user      = $left ? false : get_userdata( (int) $entry['user'] );
			$waiting[] = array(
				'who'   => $user instanceof WP_User ? (string) $user->display_name : __( 'Someone no longer on this site', 'kindgi' ),
				'left'  => $left,
				'tries' => (int) ( $entry['tries'] ?? 0 ),
				'error' => (string) ( $entry['error'] ?? '' ),
				'due'   => (int) $entry['due'],
			);
		}
		return $waiting;
	}

	/** Marks the person's statement as waiting, when Kindgi knows them; false when it doesn't. */
	private static function wait( string $subject, bool $left ): bool {
		$people = self::all();
		if ( ! isset( $people[ $subject ] ) ) {
			return false;
		}
		$people[ $subject ]['due'] = time();
		if ( $left ) {
			$people[ $subject ]['left'] = true;
		}
		self::keep( $people );
		// Should this request end before the statement is answered, wp-cron sends it.
		self::retry_at( time() + 60 );
		return true;
	}

	/** The person's user, while they're still on this site as this subject; null once they left. */
	private static function here( string $subject, array $entry ): ?WP_User {
		if ( ! empty( $entry['left'] ) ) {
			return null;
		}
		$user = get_userdata( (int) ( $entry['user'] ?? 0 ) );
		if ( ! $user instanceof WP_User || ! is_user_member_of_blog( $user->ID ) ) {
			return null;
		}
		return Kindgi_Sessions::subject_of( $user->ID ) === $subject ? $user : null;
	}

	/** A wp-cron run at `$when`, unless one comes sooner. */
	private static function retry_at( int $when ): void {
		$next = wp_next_scheduled( self::RETRY );
		if ( false === $next || $next > $when ) {
			wp_schedule_single_event( $when, self::RETRY );
		}
	}

	private static function all(): array {
		$people = get_option( self::OPTION, array() );
		return is_array( $people ) ? $people : array();
	}

	private static function keep( array $people ): void {
		update_option( self::OPTION, $people, false );
	}

	/** @return string[] */
	private static function sorted( array $roles ): array {
		$roles = array_values( array_map( 'strval', $roles ) );
		sort( $roles );
		return $roles;
	}
}
