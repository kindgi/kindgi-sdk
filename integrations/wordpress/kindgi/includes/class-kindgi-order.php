<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * A WooCommerce order and what Kindgi has about it, for the people who
 * may edit orders: a "Kindgi" box on the order's screen (what waits about
 * it, to decide there, and what was decided), a "Kindgi" column on the
 * Orders list (what waits), and a private note on the order at each
 * decision made on this site. An approval is about an order when its
 * tool says so: Kindgi puts it in the approval's `context.about`.
 */
final class Kindgi_Order {

	/** The kind an approval names in `context.about` for a WooCommerce order. */
	const ABOUT = 'woocommerce.order';

	/**
	 * The box looks through this many of the project's approvals of each
	 * kind: the oldest that wait, as the Inbox lists them, and the latest
	 * closed.
	 */
	const PAGE = 50;

	/** The column's key on the Orders list. */
	const COLUMN = 'kindgi';

	public static function register(): void {
		add_action( 'add_meta_boxes', array( self::class, 'add_box' ) );
		// The Orders list in WooCommerce's own tables (HPOS), then in posts.
		add_filter( 'woocommerce_shop_order_list_table_columns', array( self::class, 'columns' ) );
		add_action( 'woocommerce_shop_order_list_table_custom_column', array( self::class, 'order_cell' ), 10, 2 );
		add_filter( 'manage_edit-shop_order_columns', array( self::class, 'columns' ) );
		add_action( 'manage_shop_order_posts_custom_column', array( self::class, 'post_cell' ), 10, 2 );
		add_action( 'admin_enqueue_scripts', array( self::class, 'list_styles' ) );
	}

	/** Whether the site is a store: WooCommerce's order functions, which this class calls, are there. */
	public static function store(): bool {
		return function_exists( 'wc_get_order' );
	}

	/** Whether the person may read what Kindgi has about orders: on a store, only someone who may edit orders. */
	public static function reads_orders(): bool {
		return ! self::store() || current_user_can( 'edit_shop_orders' );
	}

	/** Whether the person sees what Kindgi has about orders: a connected store, and they may use Kindgi and edit orders. */
	public static function shown(): bool {
		return self::store() && null !== Kindgi_Settings::site() && Kindgi_Rest::allowed() && current_user_can( 'edit_shop_orders' );
	}

	/**
	 * The order an approval is about, by its number, or null when it's
	 * about something else (or nothing it says).
	 *
	 * @param array{kind: string, id: string}|null $about `Kindgi_Inbox::about_of`.
	 */
	public static function of( ?array $about ): ?int {
		return null !== $about && self::ABOUT === $about['kind'] && 1 === preg_match( '/^[1-9][0-9]{0,17}$/', $about['id'] ) ? (int) $about['id'] : null;
	}

	/** The screen of the order a card is about, for someone who may edit orders; else null. */
	public static function edit_url( array $card ): ?string {
		$order = self::of( $card['about'] );
		$url   = array( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil', 'get_order_admin_edit_url' );
		if ( null === $order || ! self::store() || ! current_user_can( 'edit_shop_orders' ) || ! is_callable( $url ) ) {
			return null;
		}
		// The order's screen in either order storage, as WooCommerce links it.
		return (string) call_user_func( $url, $order );
	}

	/**
	 * The approvals on Kindgi's page that are about the order. Until Kindgi
	 * lists approvals by what they're about, the box looks through a page.
	 */
	public static function about_order( array $page, int $order ): array {
		$found = array();
		foreach ( is_array( $page['data'] ?? null ) ? $page['data'] : array() as $a ) {
			if ( is_array( $a ) && self::of( Kindgi_Inbox::about_of( $a ) ) === $order ) {
				$found[] = $a;
			}
		}
		return $found;
	}

	/** The box, on an order's screen in either order storage (`wc_get_page_screen_id` names it). */
	public static function add_box(): void {
		if ( ! self::shown() || ! function_exists( 'wc_get_page_screen_id' ) ) {
			return;
		}
		add_meta_box( 'kindgi-order', __( 'Kindgi', 'kindgi' ), array( self::class, 'box' ), wc_get_page_screen_id( 'shop-order' ), 'side', 'high' );
	}

	/**
	 * The box's place: its script fills it in from the `/orders/{id}`
	 * route. A new order has nothing at Kindgi yet. WordPress gives the box
	 * itself the id `kindgi-order`, so the place has its own.
	 *
	 * @param WP_Post|WC_Order $post_or_order The order, or its post when orders are posts.
	 */
	public static function box( $post_or_order ): void {
		$order = wc_get_order( $post_or_order instanceof WP_Post ? $post_or_order->ID : $post_or_order );
		if ( ! $order instanceof WC_Order || in_array( $order->get_status(), array( 'auto-draft', 'checkout-draft' ), true ) ) {
			echo '<p class="kindgi-muted">' . esc_html__( 'What Kindgi has about the order shows here once the order is saved.', 'kindgi' ) . '</p>';
			return;
		}
		Kindgi_Admin::order_assets();
		printf(
			'<div id="kindgi-order-app" class="kindgi kindgi-order-box" data-order="%1$d"><p class="kindgi-muted">%2$s</p></div><noscript>%3$s</noscript>',
			(int) $order->get_id(),
			esc_html__( 'Loading…', 'kindgi' ),
			esc_html__( 'The Kindgi box needs JavaScript.', 'kindgi' )
		);
	}

	/** The Orders list's columns, with "Kindgi" after the status. */
	public static function columns( array $columns ): array {
		return self::shown() ? self::with_column( $columns ) : $columns;
	}

	/**
	 * The columns with Kindgi's after the status, or last when there's none.
	 * Its heading is Kindgi's mark, its name in words for screen readers;
	 * WordPress strips the mark where it shows the name as text (Screen
	 * Options, and each cell's label on a phone).
	 */
	public static function with_column( array $columns ): array {
		$heading = Kindgi_Admin::mark( 18 ) . '<span class="screen-reader-text">' . esc_html__( 'Kindgi', 'kindgi' ) . '</span>';
		$out     = array();
		foreach ( $columns as $key => $label ) {
			$out[ $key ] = $label;
			if ( 'order_status' === $key ) {
				$out[ self::COLUMN ] = $heading;
			}
		}
		if ( ! isset( $out[ self::COLUMN ] ) ) {
			$out[ self::COLUMN ] = $heading;
		}
		return $out;
	}

	/**
	 * The column's look on the Orders list, in either order storage: narrow,
	 * and what waits as a pill in WooCommerce's own colors for its statuses.
	 */
	public static function list_styles(): void {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( null === $screen || ! in_array( $screen->id, array( 'edit-shop_order', 'woocommerce_page_wc-orders' ), true ) || ! self::shown() ) {
			return;
		}
		wp_register_style( 'kindgi-orders', false, array(), KINDGI_PLUGIN_VERSION );
		wp_enqueue_style( 'kindgi-orders' );
		wp_add_inline_style(
			'kindgi-orders',
			'.wp-list-table .column-kindgi{width:8em}'
			. '.wp-list-table th.column-kindgi .kindgi-mark{display:block;border-radius:4px}'
			. '.kindgi-order-waits:empty{display:none}'
			. '.kindgi-order-waits{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;line-height:1.5}'
			. '.kindgi-waits-you{background:#f8dda7;color:#94660c}'
			. '.kindgi-waits-others{background:#e5e5e5;color:#454545}'
		);
	}

	/**
	 * The column's cell when orders are in WooCommerce's own tables.
	 *
	 * @param string   $column The column's key.
	 * @param WC_Order $order  The row's order.
	 */
	public static function order_cell( string $column, $order ): void {
		if ( self::COLUMN === $column && $order instanceof WC_Order ) {
			self::cell( (int) $order->get_id() );
		}
	}

	/** The column's cell when orders are posts. */
	public static function post_cell( string $column, int $post_id ): void {
		if ( self::COLUMN === $column ) {
			self::cell( $post_id );
		}
	}

	/**
	 * What waits about the order, from the count kept for the person
	 * (`Kindgi_Inbox::count`): the list asks Kindgi nothing. With none kept,
	 * the cell is empty until the heartbeat fills it in.
	 */
	private static function cell( int $order ): void {
		$state = self::state( Kindgi_Inbox::kept_count( get_current_user_id() ), $order );
		$class = null === $state ? ' kindgi-unknown' : ( '' === $state ? '' : ' kindgi-waits-' . $state );
		printf(
			'<span class="kindgi-order-waits%1$s" data-kindgi-order="%2$d">%3$s</span>',
			esc_attr( $class ),
			(int) $order,
			esc_html( self::waits_words( (string) $state ) )
		);
	}

	/**
	 * Whether an approval about the order waits: `you`, `others`, '' for
	 * none, or null when no count is kept to say.
	 *
	 * @param array{n: int, more: bool, orders: array<string, string>}|null $count
	 */
	public static function state( ?array $count, int $order ): ?string {
		return null === $count ? null : (string) ( $count['orders'][ (string) $order ] ?? '' );
	}

	/** A cell's words, as the heartbeat's script writes them too (`kindgi-count.js`). */
	public static function waits_words( string $state ): string {
		if ( 'you' === $state ) {
			return __( 'Waits for you', 'kindgi' );
		}
		return 'others' === $state ? __( 'Waits for a reviewer', 'kindgi' ) : '';
	}

	/**
	 * A private note on the order a card is about, at a decision made on
	 * this site, by the person who made it. A decision made elsewhere (in
	 * Kindgi's console) writes none: the order's box shows it anyway.
	 *
	 * @param array   $card     The approval, as `Kindgi_Inbox::card` has it.
	 * @param string  $decision `approve` or `reject`.
	 * @param string  $reason   Why, or ''.
	 * @param WP_User $user     Who decided.
	 */
	public static function note( array $card, string $decision, string $reason, WP_User $user ): void {
		$id = self::of( $card['about'] );
		if ( null === $id || ! self::store() ) {
			return;
		}
		$order = wc_get_order( $id );
		if ( $order instanceof WC_Order ) {
			$order->add_order_note( self::note_text( $card['heading'], $decision, $reason, $user->display_name ), 0, true );
		}
	}

	/** "Kindgi: Large refund: 210.00 on order #1234. Approved by Shop Owner." */
	public static function note_text( string $heading, string $decision, string $reason, string $name ): string {
		// A tool's own title may end with a period: the note adds its own.
		$heading = rtrim( $heading, '.' );
		if ( 'reject' === $decision ) {
			/* translators: 1: what was asked, 2: who decided, 3: why */
			return sprintf( __( 'Kindgi: %1$s. Rejected by %2$s: %3$s', 'kindgi' ), $heading, $name, $reason );
		}
		if ( '' === $reason ) {
			/* translators: 1: what was asked, 2: who decided */
			return sprintf( __( 'Kindgi: %1$s. Approved by %2$s.', 'kindgi' ), $heading, $name );
		}
		/* translators: 1: what was asked, 2: who decided, 3: why */
		return sprintf( __( 'Kindgi: %1$s. Approved by %2$s: %3$s', 'kindgi' ), $heading, $name, $reason );
	}
}
