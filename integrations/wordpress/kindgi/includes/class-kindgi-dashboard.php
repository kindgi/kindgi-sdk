<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * Kindgi on the WordPress dashboard, the first screen staff see: what
 * waits for them, what the agents did last, and a box to ask. For whoever
 * may use Kindgi on a connected site. Drawing it asks Kindgi nothing: the
 * count is the one the heartbeat keeps, and its script asks for the rest
 * on the person's live session only (`/dashboard`), as the order's box does.
 */
final class Kindgi_Dashboard {

	/** How many of the project's latest runs the box shows. */
	const RUNS = 3;

	/** How many of the approvals that wait for the person the box names. */
	const NAMED = 2;

	public static function register(): void {
		add_action( 'wp_dashboard_setup', array( self::class, 'add' ) );
	}

	/** Whether the person sees the box: a connected site, and they may use Kindgi. */
	public static function shown(): bool {
		return null !== Kindgi_Settings::site() && Kindgi_Rest::allowed();
	}

	/** The box, first on the dashboard; anyone can hide it under Screen Options. */
	public static function add(): void {
		if ( self::shown() ) {
			wp_add_dashboard_widget( 'kindgi', __( 'Kindgi', 'kindgi' ), array( self::class, 'box' ), null, null, 'normal', 'high' );
		}
	}

	/**
	 * The box's place, with the count kept for the person drawn at once,
	 * and the box to ask, which works without the script too: it opens Ask
	 * with the question written in, to send there.
	 */
	public static function box(): void {
		Kindgi_Admin::dashboard_assets();
		$count = Kindgi_Inbox::kept_count( get_current_user_id() );
		echo '<div id="kindgi-dashboard-app" class="kindgi kindgi-dash">';
		echo '<div class="kindgi-dash-live">';
		if ( null !== $count ) {
			echo '<p class="kindgi-dash-waits">' . self::waits_html( $count['n'], $count['more'] ) . '</p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped in waits_html.
		}
		echo '<p class="kindgi-muted">' . esc_html__( 'Loading…', 'kindgi' ) . '</p>';
		echo '</div>';
		self::ask_form();
		echo '</div>';
	}

	/** "2 approvals wait for you", linked to the Inbox; "Nothing waits for you." when none does. */
	public static function waits_html( int $n, bool $more ): string {
		if ( 0 === $n ) {
			return esc_html__( 'Nothing waits for you.', 'kindgi' );
		}
		$number = $more ? number_format_i18n( $n ) . '+' : number_format_i18n( $n );
		return '<a href="' . esc_url( admin_url( 'admin.php?page=' . Kindgi_Admin::PAGE ) ) . '">' . esc_html(
			sprintf(
				/* translators: %s: how many, such as 3 or 12+ */
				_n( '%s approval waits for you', '%s approvals wait for you', $n, 'kindgi' ),
				$number
			)
		) . '</a>';
	}

	/** The box to ask: Ask opens with the question in it, and the person sends it there. */
	private static function ask_form(): void {
		$placeholder = Kindgi_Order::store()
			? __( 'Ask about an order, a customer or the store', 'kindgi' )
			: __( 'Ask about the site', 'kindgi' );
		?>
		<form class="kindgi-dash-ask" method="get" action="<?php echo esc_url( admin_url( 'admin.php' ) ); ?>">
			<input type="hidden" name="page" value="<?php echo esc_attr( Kindgi_Admin::ASK_PAGE ); ?>">
			<label class="screen-reader-text" for="kindgi-dash-question"><?php esc_html_e( 'Ask Kindgi', 'kindgi' ); ?></label>
			<textarea id="kindgi-dash-question" name="question" rows="2" maxlength="<?php echo (int) Kindgi_Rest::MESSAGE_MAX; ?>" placeholder="<?php echo esc_attr( $placeholder ); ?>"></textarea>
			<button type="submit" class="button button-primary"><?php esc_html_e( 'Ask', 'kindgi' ); ?></button>
		</form>
		<?php
	}

	/**
	 * The box's answer, from Kindgi's pages: the person's count, the oldest
	 * approvals that wait for them, and the latest runs with their agents'
	 * names. What a run returned stays on Activity: its row's first line is
	 * enough here, and only when the person may read it.
	 *
	 * @param array{waiting: array, runs: array, agents: array} $pages Kindgi's lists, by what they hold.
	 * @param array{n: int, more: bool}                       $count `Kindgi_Inbox::count_of` on the waiting page.
	 * @param string                                          $me       The person's Kindgi id.
	 * @param array|null                                      $reviewer The person as a reviewer (`reviewer_of`).
	 */
	public static function answer( array $pages, array $count, string $me, ?array $reviewer ): array {
		$who   = array( 'Kindgi_Rest', 'who' );
		$named = array();
		foreach ( self::data( $pages['waiting'] ) as $a ) {
			$card = Kindgi_Inbox::card( $a, $me, $reviewer, $who );
			if ( 'you' === $card['waitsFor'] && count( $named ) < self::NAMED ) {
				$named[] = array(
					'id'        => $card['id'],
					'heading'   => $card['heading'],
					'createdAt' => $card['createdAt'],
				);
			}
		}
		$names = array();
		foreach ( self::data( $pages['agents'] ) as $agent ) {
			if ( is_string( $agent['id'] ?? null ) ) {
				$names[ $agent['id'] ] = is_string( $agent['name'] ?? null ) && '' !== $agent['name'] ? $agent['name'] : $agent['id'];
			}
		}
		$reads_orders = Kindgi_Order::reads_orders();
		$runs         = array();
		foreach ( array_slice( self::data( $pages['runs'] ), 0, self::RUNS ) as $run ) {
			$row    = Kindgi_Activity::row( $run, $me, $who, $reads_orders );
			$runs[] = array(
				'id'        => $row['id'],
				'name'      => null !== $row['agentId'] ? ( $names[ $row['agentId'] ] ?? $row['agentId'] ) : ( $row['flow'] ?? '' ),
				'status'    => $row['status'],
				'waiting'   => $row['waiting'],
				'createdAt' => $row['createdAt'],
				'summary'   => $row['summary'],
			);
		}
		return array(
			'signedIn' => true,
			'count'    => $count['n'],
			'more'     => $count['more'],
			'waiting'  => $named,
			'runs'     => $runs,
		);
	}

	/** A Kindgi list's items that are objects. */
	private static function data( array $page ): array {
		return array_values( array_filter( is_array( $page['data'] ?? null ) ? $page['data'] : array(), 'is_array' ) );
	}
}
