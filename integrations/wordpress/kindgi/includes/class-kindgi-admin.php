<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * The wp-admin side: the Kindgi menu, with a count of what waits for the
 * person (also in the admin bar), and its pages: Inbox (what waits for a
 * person, and what was decided), Activity (what the agents did), Ask
 * (conversations with the agents offered to staff), and Settings, where an
 * administrator connects the site with the one-time code from Kindgi and
 * chooses the agents offered.
 */
final class Kindgi_Admin {

	/** The Inbox's slug, the menu's own: an approval's link is `admin.php?page=kindgi&approval=<id>`. */
	const PAGE = 'kindgi';

	/** The other pages' slugs. */
	const ACTIVITY_PAGE = 'kindgi-activity';
	const ASK_PAGE      = 'kindgi-ask';
	const SETTINGS_PAGE = 'kindgi-settings';

	/** The connect form's action and nonce. */
	const CONNECT = 'kindgi_connect';

	/** The offered-agents form's action and nonce. */
	const OFFER = 'kindgi_offer';

	/** The page each admin hook shows (`inbox`, `activity`, `ask`), as the menu made them. */
	private static $views = array();

	/** Settings' admin hook, as the menu made it: false until then, or for someone who can't open it. */
	private static $settings_hook = false;

	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'menu' ) );
		// After every plugin's menu: the count goes on the menu's title, not into its pages' hook names.
		add_action( 'admin_menu', array( self::class, 'count_on_menu' ), 99 );
		add_action( 'admin_bar_menu', array( self::class, 'admin_bar' ), 80 );
		add_action( 'admin_enqueue_scripts', array( self::class, 'assets' ) );
		add_action( 'admin_post_' . self::CONNECT, array( self::class, 'connect' ) );
		add_action( 'admin_post_' . self::OFFER, array( self::class, 'offer' ) );
		add_filter( 'wp_privacy_personal_data_exporters', array( self::class, 'exporters' ) );
		add_filter( 'wp_privacy_personal_data_erasers', array( self::class, 'erasers' ) );
	}

	/**
	 * Who sees the Kindgi pages. Kindgi decides the rest from the person's
	 * roles on this site (a role it doesn't allow is refused there).
	 */
	public static function capability(): string {
		/**
		 * The capability the Kindgi pages need (Settings needs `manage_options`).
		 *
		 * @param string $capability Default `manage_woocommerce` with WooCommerce (shop managers and
		 *                           administrators), otherwise `edit_others_posts` (editors and
		 *                           administrators); never authors, contributors or customers.
		 */
		return (string) apply_filters( 'kindgi_capability', class_exists( 'WooCommerce' ) ? 'manage_woocommerce' : 'edit_others_posts' );
	}

	/** WordPress's personal-data export (Tools → Export Personal Data): what the plugin keeps about a person. */
	public static function exporters( array $exporters ): array {
		$exporters['kindgi'] = array(
			'exporter_friendly_name' => __( 'Kindgi', 'kindgi' ),
			'callback'               => array( self::class, 'export' ),
		);
		return $exporters;
	}

	/** WordPress's personal-data erasure (Tools → Erase Personal Data). */
	public static function erasers( array $erasers ): array {
		$erasers['kindgi'] = array(
			'eraser_friendly_name' => __( 'Kindgi', 'kindgi' ),
			'callback'             => array( self::class, 'erase' ),
		);
		return $erasers;
	}

	/** The person's subject and Kindgi id on this site, if they have them. */
	public static function export( string $email ): array {
		$user = get_user_by( 'email', $email );
		$data = array();
		if ( false !== $user ) {
			foreach (
				array(
					Kindgi_Sessions::SUBJECT => __( 'Subject sent to Kindgi', 'kindgi' ),
					Kindgi_Sessions::USER_ID => __( 'Person id at Kindgi', 'kindgi' ),
				) as $key => $name
			) {
				$value = get_user_option( $key, $user->ID );
				if ( is_string( $value ) && '' !== $value ) {
					$data[] = array(
						'name'  => $name,
						'value' => $value,
					);
				}
			}
		}
		return array(
			'data' => array() === $data ? array() : array(
				array(
					'group_id'    => 'kindgi',
					'group_label' => __( 'Kindgi', 'kindgi' ),
					'item_id'     => 'kindgi-' . $user->ID,
					'data'        => $data,
				),
			),
			'done' => true,
		);
	}

	/**
	 * Forgets the person here: their subject, Kindgi id and cached
	 * session, and tells Kindgi they left this site, which ends their
	 * grants and sessions there for good (`Kindgi_People`). Their record at
	 * Kindgi stays. Signing in again later makes them a new person there.
	 */
	public static function erase( string $email ): array {
		$user     = get_user_by( 'email', $email );
		$removed  = false;
		$retained = false;
		if ( false !== $user ) {
			foreach ( array( Kindgi_Sessions::SUBJECT, Kindgi_Sessions::USER_ID, Kindgi_Sessions::SESSION ) as $key ) {
				$removed = $removed || false !== get_user_option( $key, $user->ID );
			}
			// Kindgi keeps its record of someone it knew, and their name on what they did.
			$retained = false !== get_user_option( Kindgi_Sessions::USER_ID, $user->ID );
			Kindgi_People::left( $user->ID );
			// So does this site, while the statement that they left waits to reach Kindgi.
			$retained = $retained || Kindgi_People::waiting_for( $user->ID );
		}
		return array(
			'items_removed'  => $removed,
			'items_retained' => $retained,
			'messages'       => $retained ? array( __( 'Kindgi is told this person left this site, which ends their access there for good. Kindgi keeps its own record of them, and their name stays on what they did.', 'kindgi' ) ) : array(),
			'done'           => true,
		);
	}

	public static function menu(): void {
		$capability = self::capability();
		add_menu_page(
			__( 'Kindgi', 'kindgi' ),
			__( 'Kindgi', 'kindgi' ),
			$capability,
			self::PAGE,
			array( self::class, 'page' ),
			'dashicons-format-chat',
			58
		);
		foreach ( self::pages() as $slug => $page ) {
			$hook = add_submenu_page( self::PAGE, $page['title'], $page['title'], $capability, $slug, array( self::class, 'page' ) );
			if ( false !== $hook ) {
				self::$views[ $hook ] = $page['view'];
			}
		}
		self::$settings_hook = add_submenu_page( self::PAGE, __( 'Kindgi settings', 'kindgi' ), __( 'Settings', 'kindgi' ), 'manage_options', self::SETTINGS_PAGE, array( self::class, 'settings' ) );
	}

	/** The pages staff use, by slug: the Inbox first, as the menu's own page. */
	private static function pages(): array {
		return array(
			self::PAGE          => array(
				'title' => __( 'Inbox', 'kindgi' ),
				'view'  => 'inbox',
			),
			self::ACTIVITY_PAGE => array(
				'title' => __( 'Activity', 'kindgi' ),
				'view'  => 'activity',
			),
			self::ASK_PAGE      => array(
				'title' => __( 'Ask', 'kindgi' ),
				'view'  => 'ask',
			),
		);
	}

	/**
	 * The count of what waits for the person, on the Kindgi menu, in
	 * WordPress's own bubble (hidden at 0). It shows the count kept from
	 * Kindgi's last answer; the heartbeat keeps it fresh (`Kindgi_Inbox`).
	 */
	public static function count_on_menu(): void {
		global $menu;
		if ( ! is_array( $menu ) || null === Kindgi_Settings::site() ) {
			return;
		}
		foreach ( $menu as $at => $item ) {
			if ( self::PAGE === ( $item[2] ?? null ) ) {
				$menu[ $at ][0] .= ' ' . self::bubble( Kindgi_Inbox::kept_count( get_current_user_id() ) );
			}
		}
	}

	/**
	 * WordPress's count bubble, as the Comments and Plugins menus have it.
	 *
	 * @param array{n: int, more: bool}|null $count Null shows none.
	 */
	private static function bubble( ?array $count ): string {
		$n = null === $count ? 0 : $count['n'];
		return sprintf(
			'<span class="awaiting-mod count-%1$d kindgi-count"><span class="pending-count" aria-hidden="true">%2$s</span><span class="screen-reader-text">%3$s</span></span>',
			$n,
			esc_html( self::count_text( $count ) ),
			esc_html( self::waiting_words( $count ) )
		);
	}

	/** The count as shown: "12", or "12+" when there may be more; never "0+". */
	private static function count_text( ?array $count ): string {
		return null === $count ? '0' : number_format_i18n( $count['n'] ) . ( $count['more'] && $count['n'] > 0 ? '+' : '' );
	}

	/** "2 wait for you", for a screen reader. */
	private static function waiting_words( ?array $count ): string {
		/* translators: %s: how many approvals wait for the person, "12" or "12+" */
		return sprintf( _n( '%s waits for you', '%s wait for you', null === $count ? 0 : $count['n'], 'kindgi' ), self::count_text( $count ) );
	}

	/** The count in the admin bar too, on every admin page, linking to the Inbox; hidden at 0. */
	public static function admin_bar( WP_Admin_Bar $bar ): void {
		if ( ! is_admin() || ! current_user_can( self::capability() ) || null === Kindgi_Settings::site() ) {
			return;
		}
		$count = Kindgi_Inbox::kept_count( get_current_user_id() );
		$bar->add_node(
			array(
				'id'    => 'kindgi-inbox',
				'title' => '<span class="ab-icon dashicons dashicons-format-chat" aria-hidden="true"></span><span class="ab-label kindgi-count-label">' . esc_html( self::count_text( $count ) ) . '</span><span class="screen-reader-text kindgi-count-words">' . esc_html( self::waiting_words( $count ) ) . '</span>',
				'href'  => admin_url( 'admin.php?page=' . self::PAGE ),
				'meta'  => array(
					'class' => null === $count || 0 === $count['n'] ? 'kindgi-none' : '',
					'title' => __( 'Kindgi inbox', 'kindgi' ),
				),
			)
		);
	}

	public static function assets( string $hook ): void {
		$version = KINDGI_PLUGIN_VERSION;
		if ( current_user_can( self::capability() ) && null !== Kindgi_Settings::site() ) {
			// On every admin page: the heartbeat brings the count to the menu and the admin bar.
			wp_enqueue_script( 'kindgi-count', plugins_url( 'assets/kindgi-count.js', KINDGI_PLUGIN_FILE ), array( 'heartbeat', 'jquery', 'wp-i18n' ), $version, true );
			wp_set_script_translations( 'kindgi-count', 'kindgi' );
			wp_add_inline_style( 'admin-bar', '#wpadminbar #wp-admin-bar-kindgi-inbox.kindgi-none{display:none}#wpadminbar #wp-admin-bar-kindgi-inbox .ab-icon:before{top:2px}' );
		}
		if ( false !== self::$settings_hook && self::$settings_hook === $hook ) {
			// A Kindgi page's look, connected or not; its script copies the addresses before, and asks Kindgi after.
			wp_enqueue_style( 'kindgi-admin', plugins_url( 'assets/kindgi-admin.css', KINDGI_PLUGIN_FILE ), array(), $version );
			wp_enqueue_script( 'kindgi-settings', plugins_url( 'assets/kindgi-settings.js', KINDGI_PLUGIN_FILE ), array( 'wp-api-fetch', 'wp-i18n' ), $version, true );
			wp_set_script_translations( 'kindgi-settings', 'kindgi' );
		}
		if ( ! isset( self::$views[ $hook ] ) ) {
			return;
		}
		wp_enqueue_style( 'kindgi-admin', plugins_url( 'assets/kindgi-admin.css', KINDGI_PLUGIN_FILE ), array(), $version );
		self::register_cards();
		wp_enqueue_script( 'kindgi-admin', plugins_url( 'assets/kindgi-admin.js', KINDGI_PLUGIN_FILE ), array( 'kindgi-cards' ), $version, true );
		wp_set_script_translations( 'kindgi-admin', 'kindgi' );
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- links to open, not actions.
		$approval     = isset( $_GET['approval'] ) ? sanitize_text_field( wp_unslash( $_GET['approval'] ) ) : '';
		$conversation = isset( $_GET['conversation'] ) ? sanitize_text_field( wp_unslash( $_GET['conversation'] ) ) : '';
		$run          = isset( $_GET['run'] ) ? sanitize_text_field( wp_unslash( $_GET['run'] ) ) : '';
		$order        = isset( $_GET['order'] ) ? absint( $_GET['order'] ) : 0;
		$question     = isset( $_GET['question'] ) ? trim( sanitize_textarea_field( wp_unslash( $_GET['question'] ) ) ) : '';
		// phpcs:enable
		$id     = '/^' . Kindgi_Rest::ID . '$/';
		$config = array(
			'view'         => self::$views[ $hook ],
			'approval'     => preg_match( $id, $approval ) ? $approval : null,
			'conversation' => preg_match( $id, $conversation ) ? $conversation : null,
			// A run's link on Activity: its row, marked.
			'run'          => 'activity' === self::$views[ $hook ] && preg_match( $id, $run ) ? $run : null,
			// "Ask about this order", from the order's box: a new conversation's first words name it.
			'order'        => $order > 0 && Kindgi_Order::shown() ? $order : null,
			// The dashboard box's question: a new conversation's first words, to send on Ask.
			'question'     => '' !== $question ? mb_substr( $question, 0, Kindgi_Rest::MESSAGE_MAX ) : null,
			'pollMs'       => 1500,
			'urls'         => self::urls(),
			// Administrators see Kindgi's own words about an error, under Details.
			'admin'        => current_user_can( 'manage_options' ),
			// A store: Ask offers a store's first questions.
			'store'        => Kindgi_Order::store(),
		);
		wp_add_inline_script( 'kindgi-cards', 'window.kindgiConfig = ' . wp_json_encode( $config ) . ';', 'before' );
	}

	/** The Kindgi pages' addresses, for the scripts. */
	private static function urls(): array {
		return array(
			'inbox'    => admin_url( 'admin.php?page=' . self::PAGE ),
			'activity' => admin_url( 'admin.php?page=' . self::ACTIVITY_PAGE ),
			'ask'      => admin_url( 'admin.php?page=' . self::ASK_PAGE ),
			'settings' => current_user_can( 'manage_options' ) ? admin_url( 'admin.php?page=' . self::SETTINGS_PAGE ) : null,
		);
	}

	/**
	 * The order box's script and styles (`Kindgi_Order::box`), enqueued as
	 * the box draws, so only an order's screen with the box loads them.
	 */
	public static function order_assets(): void {
		self::box_assets( 'kindgi-order' );
	}

	/**
	 * The dashboard box's script and styles (`Kindgi_Dashboard::box`),
	 * enqueued as the box draws, so only a dashboard with the box loads them.
	 */
	public static function dashboard_assets(): void {
		self::box_assets( 'kindgi-dashboard' );
	}

	/** A box's script on another screen than Kindgi's, with the cards it draws with and their styles. */
	private static function box_assets( string $handle ): void {
		$version = KINDGI_PLUGIN_VERSION;
		wp_enqueue_style( 'kindgi-admin', plugins_url( 'assets/kindgi-admin.css', KINDGI_PLUGIN_FILE ), array(), $version );
		self::register_cards();
		wp_enqueue_script( $handle, plugins_url( 'assets/' . $handle . '.js', KINDGI_PLUGIN_FILE ), array( 'kindgi-cards' ), $version, true );
		wp_set_script_translations( $handle, 'kindgi' );
		wp_add_inline_script(
			'kindgi-cards',
			'window.kindgiConfig = ' . wp_json_encode(
				array(
					'urls'  => self::urls(),
					'admin' => current_user_can( 'manage_options' ),
				)
			) . ';',
			'before'
		);
	}

	/** A page staff use: its heading, then the app, which shows the page's view. */
	public static function page(): void {
		$view  = self::$views[ current_filter() ] ?? 'inbox';
		$pages = wp_list_pluck( self::pages(), 'title', 'view' );
		echo '<div class="wrap kindgi">';
		self::header( $pages[ $view ] ?? __( 'Kindgi', 'kindgi' ) );
		if ( null === Kindgi_Settings::site() ) {
			self::not_connected();
			echo '</div>';
			return;
		}
		echo '<div id="kindgi-app"></div><noscript>' . esc_html__( 'The Kindgi pages need JavaScript.', 'kindgi' ) . '</noscript></div>';
	}

	/**
	 * A Kindgi page's heading, with Kindgi's mark. WordPress puts its notices
	 * after `wp-header-end`, so they show below it.
	 */
	public static function header( string $title ): void {
		echo '<div class="kindgi-header">' . self::mark() . '<h1>' . esc_html( $title ) . '</h1></div><hr class="wp-header-end">';
	}

	/** Kindgi's mark: its tile and K, drawn inline (no request, and no color from WordPress's menu). */
	public static function mark( int $size = 28 ): string {
		return '<svg class="kindgi-mark" viewBox="0 0 32 32" width="' . $size . '" height="' . $size . '" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="7" fill="#6c1a5a"/><path d="M9 8v16M9 16l7-8M9 16l7 8M20 8v16M20 16h5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
	}

	/** A Kindgi page before the site is connected: the way to connect it, for whoever can. */
	private static function not_connected(): void {
		echo '<div class="kindgi-empty"><p class="kindgi-empty-title">' . esc_html__( "This site isn't connected to Kindgi yet", 'kindgi' ) . '</p>';
		if ( current_user_can( 'manage_options' ) ) {
			echo '<p>' . esc_html__( "Once it is, your staff see what the agents want them to decide, what they did, and can ask them about the site, signed in as themselves.", 'kindgi' ) . '</p>';
			echo '<p class="kindgi-empty-actions"><a class="button button-primary" href="' . esc_url( admin_url( 'admin.php?page=' . self::SETTINGS_PAGE ) ) . '">' . esc_html__( 'Connect it in Settings', 'kindgi' ) . '</a></p>';
		} else {
			echo '<p>' . esc_html__( 'An administrator of this site connects it, under Kindgi → Settings.', 'kindgi' ) . '</p>';
		}
		echo '</div>';
	}

	/** The approval cards' script, which the Kindgi pages and the order's box share. */
	public static function register_cards(): void {
		wp_register_script( 'kindgi-cards', plugins_url( 'assets/kindgi-cards.js', KINDGI_PLUGIN_FILE ), array( 'wp-api-fetch', 'wp-date', 'wp-i18n' ), KINDGI_PLUGIN_VERSION, true );
		wp_set_script_translations( 'kindgi-cards', 'kindgi' );
	}

	/**
	 * Settings, for administrators. Connected: the connection at a glance,
	 * the agents offered to staff, and the site's own details folded away.
	 * Not connected yet: the two steps that connect it.
	 */
	public static function settings(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$site   = Kindgi_Settings::site();
		$notice = get_transient( self::notice_key() );
		delete_transient( self::notice_key() );
		?>
		<div class="wrap kindgi kindgi-settings">
			<?php self::header( __( 'Kindgi settings', 'kindgi' ) ); ?>
			<?php if ( is_array( $notice ) ) : ?>
				<div class="notice notice-<?php echo 'ok' === $notice['kind'] ? 'success' : 'error'; ?>"><p><?php echo esc_html( $notice['message'] ); ?></p></div>
			<?php endif; ?>
			<?php if ( null === $site ) : ?>
				<?php self::webhooks_off(); ?>
				<?php self::connect_steps(); ?>
			<?php else : ?>
				<?php self::status( $site ); ?>
				<?php self::webhooks_off(); ?>
				<?php self::waiting(); ?>

				<h2><?php esc_html_e( 'Agents offered to staff', 'kindgi' ); ?></h2>
				<?php self::offer_form(); ?>

				<h2><?php esc_html_e( 'Who may do what', 'kindgi' ); ?></h2>
				<p class="kindgi-settings-text"><?php esc_html_e( "Who here may ask the agents, and who decides approvals, is set at Kindgi on this site's registration: a site can't give itself rights.", 'kindgi' ); ?></p>

				<details class="kindgi-advanced">
					<summary><?php esc_html_e( 'Technical details', 'kindgi' ); ?></summary>
					<?php self::site_table( $site ); ?>
					<?php self::connect_form( true ); ?>
				</details>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * The connection at a glance: a row each for the connection, signing
	 * staff in, store events and changes on their way, from what the site
	 * keeps, so Settings never waits on Kindgi. The page's script adds the
	 * project's name and checks signing in (`kindgi-settings.js`).
	 */
	private static function status( array $site ): void {
		echo '<ul class="kindgi-status" role="list" aria-live="polite">';
		self::status_row(
			'ok',
			__( 'Connected', 'kindgi' ),
			/* translators: %s: Kindgi's public URL */
			sprintf( esc_html__( 'To Kindgi at %s.', 'kindgi' ), '<code>' . esc_html( $site['audience'] ) . '</code>' ),
			array(
				'id'            => 'kindgi-connected',
				'data-audience' => $site['audience'],
			)
		);
		$problems = self::problems( $site );
		if ( array() !== $problems ) {
			self::status_row( 'err', __( "Staff can't sign in", 'kindgi' ), esc_html( implode( ' ', $problems ) ) );
		} else {
			self::status_row( 'checking', __( 'Staff sign in as themselves', 'kindgi' ), esc_html__( 'Checking with Kindgi…', 'kindgi' ), array( 'id' => 'kindgi-signin' ) );
		}
		self::store_events_row();
		$waiting = count( Kindgi_People::waiting() );
		if ( $waiting > 0 ) {
			self::status_row(
				'warn',
				__( 'Changes on their way', 'kindgi' ),
				esc_html(
					sprintf(
						/* translators: %s: how many people */
						_n( "%s person's change hasn't reached Kindgi yet. WordPress keeps trying.", "%s people's changes haven't reached Kindgi yet. WordPress keeps trying.", $waiting, 'kindgi' ),
						number_format_i18n( $waiting )
					)
				) . ' <a href="#kindgi-waiting">' . esc_html__( 'See them', 'kindgi' ) . '</a>'
			);
		}
		echo '</ul>';
	}

	/** Whether WooCommerce's events reach Kindgi: its webhooks to Kindgi, on and off. None without WooCommerce. */
	private static function store_events_row(): void {
		$on = Kindgi_Webhooks::on();
		if ( null === $on ) {
			return;
		}
		$off = count( Kindgi_Webhooks::off() );
		if ( $off > 0 ) {
			self::status_row(
				'err',
				__( "Store events don't all reach Kindgi", 'kindgi' ),
				esc_html(
					sprintf(
						/* translators: %s: how many webhooks */
						_n( 'WooCommerce turned off %s webhook to Kindgi: turn it on again below.', 'WooCommerce turned off %s webhooks to Kindgi: turn them on again below.', $off, 'kindgi' ),
						number_format_i18n( $off )
					)
				)
			);
			return;
		}
		if ( $on > 0 ) {
			self::status_row(
				'ok',
				__( 'Store events reach Kindgi', 'kindgi' ),
				esc_html(
					sprintf(
						/* translators: %s: how many webhooks */
						_n( '%s WooCommerce webhook delivers to Kindgi.', '%s WooCommerce webhooks deliver to Kindgi.', $on, 'kindgi' ),
						number_format_i18n( $on )
					)
				)
			);
			return;
		}
		$where = esc_html__( 'WooCommerce → Settings → Advanced → Webhooks', 'kindgi' );
		if ( current_user_can( 'manage_woocommerce' ) ) {
			$where = '<a href="' . esc_url( admin_url( 'admin.php?page=wc-settings&tab=advanced&section=webhooks' ) ) . '">' . $where . '</a>';
		}
		$paused = Kindgi_Webhooks::paused();
		if ( $paused > 0 ) {
			self::status_row(
				'warn',
				__( 'Store events are paused', 'kindgi' ),
				sprintf(
					/* translators: 1: how many webhooks, 2: where WooCommerce's webhooks are set up */
					esc_html( _n( '%1$s WooCommerce webhook to Kindgi is paused. Set it to Active under %2$s.', '%1$s WooCommerce webhooks to Kindgi are paused. Set one to Active under %2$s.', $paused, 'kindgi' ) ),
					esc_html( number_format_i18n( $paused ) ),
					$where
				)
			);
			return;
		}
		self::status_row(
			'none',
			__( 'No store events go to Kindgi', 'kindgi' ),
			/* translators: %s: where WooCommerce's webhooks are set up */
			sprintf( esc_html__( 'No WooCommerce webhook delivers to Kindgi. An agent that starts on a store event needs one, under %s.', 'kindgi' ), $where )
		);
	}

	/**
	 * One row of the connection at a glance: its state as a dot and in its
	 * title's words, then what it means.
	 *
	 * @param string                $state ok, err, warn, none or checking.
	 * @param string                $title What the row says, in words: never the dot alone.
	 * @param string                $html  The rest, escaped by the caller.
	 * @param array<string, string> $attrs The row's own attributes.
	 */
	private static function status_row( string $state, string $title, string $html, array $attrs = array() ): void {
		$more = '';
		foreach ( $attrs as $name => $value ) {
			$more .= ' ' . $name . '="' . esc_attr( $value ) . '"';
		}
		echo '<li class="kindgi-status-row kindgi-status-' . esc_attr( $state ) . '"' . $more . '>' // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- each value is escaped above.
			. '<span class="kindgi-dot" aria-hidden="true"></span>'
			. '<div class="kindgi-status-words"><strong class="kindgi-status-title">' . esc_html( $title ) . '</strong>'
			. '<div class="kindgi-status-text">' . $html . '</div></div></li>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped by the caller.
	}

	/**
	 * Not connected yet: the two steps, the addresses Kindgi registers to
	 * copy, and the form for the code Kindgi gives back.
	 */
	private static function connect_steps(): void {
		?>
		<div class="kindgi-connect">
			<h2><?php esc_html_e( 'Connect this site to Kindgi', 'kindgi' ); ?></h2>
			<p class="kindgi-settings-text"><?php esc_html_e( 'Your staff then see what the agents want them to decide and what they did, and ask them about the site, each signed in as themselves.', 'kindgi' ); ?></p>
			<ol class="kindgi-connect-steps" role="list">
				<li>
					<h3><?php esc_html_e( 'Ask your Kindgi administrator to register this site', 'kindgi' ); ?></h3>
					<p><?php esc_html_e( 'On the project your staff will use, with these two addresses:', 'kindgi' ); ?></p>
					<dl class="kindgi-addresses">
						<dt><?php esc_html_e( 'Origin', 'kindgi' ); ?></dt>
						<dd><code data-kindgi-copy><?php echo esc_html( Kindgi_Settings::home_origin() ); ?></code></dd>
						<dt><?php esc_html_e( 'Approvals URL', 'kindgi' ); ?></dt>
						<dd><code data-kindgi-copy><?php echo esc_html( Kindgi_Settings::approvals_url() ); ?></code></dd>
					</dl>
				</li>
				<li>
					<h3><?php esc_html_e( 'Paste the one-time code they send back', 'kindgi' ); ?></h3>
					<p><?php esc_html_e( 'It works once, within 15 minutes. If it ran out, they can make a new one.', 'kindgi' ); ?></p>
					<?php self::connect_form( false ); ?>
				</li>
			</ol>
			<details class="kindgi-advanced">
				<summary><?php esc_html_e( 'Technical details', 'kindgi' ); ?></summary>
				<?php self::site_table( null ); ?>
			</details>
		</div>
		<?php
	}

	/**
	 * The site's details: its id once connected, the two addresses Kindgi
	 * registers, where Kindgi is, and its key.
	 */
	private static function site_table( ?array $site ): void {
		$url = Kindgi_Settings::url();
		?>
		<table class="form-table" role="presentation">
			<?php if ( null !== $site ) : ?>
				<tr>
					<th scope="row"><?php esc_html_e( 'Site id', 'kindgi' ); ?></th>
					<td>
						<code><?php echo esc_html( $site['site_id'] ); ?></code>
						<p class="description">
							<?php
							printf(
								/* translators: %s: the command that shows a site's registration */
								esc_html__( "Its registration at Kindgi, with who may do what and its keys: %s", 'kindgi' ),
								'<code>' . esc_html( 'kindgi sites get ' . $site['site_id'] ) . '</code>'
							);
							?>
						</p>
					</td>
				</tr>
				<tr><th scope="row"><?php esc_html_e( 'Kindgi', 'kindgi' ); ?></th><td><code><?php echo esc_html( $site['audience'] ); ?></code></td></tr>
				<?php if ( '' !== $url && rtrim( $site['audience'], '/' ) !== $url ) : ?>
					<tr>
						<th scope="row"><?php esc_html_e( 'Kindgi, from this server', 'kindgi' ); ?></th>
						<td>
							<code><?php echo esc_html( $url ); ?></code>
							<p class="description"><?php esc_html_e( "This server reaches Kindgi here; browsers and Kindgi's links use the address above.", 'kindgi' ); ?></p>
						</td>
					</tr>
				<?php endif; ?>
			<?php endif; ?>
			<tr><th scope="row"><?php esc_html_e( 'Origin', 'kindgi' ); ?></th><td><code><?php echo esc_html( Kindgi_Settings::home_origin() ); ?></code></td></tr>
			<tr><th scope="row"><?php esc_html_e( 'Approvals URL', 'kindgi' ); ?></th><td><code><?php echo esc_html( Kindgi_Settings::approvals_url() ); ?></code></td></tr>
			<tr>
				<th scope="row"><?php esc_html_e( 'Signing key', 'kindgi' ); ?></th>
				<td><?php self::key_status( Kindgi_Keys::source() ); ?></td>
			</tr>
		</table>
		<?php
	}

	/** Connect with a one-time code from Kindgi, or connect again with a new one. */
	private static function connect_form( bool $again ): void {
		?>
		<?php if ( $again ) : ?>
			<h3><?php esc_html_e( 'Connect again', 'kindgi' ); ?></h3>
			<p><?php esc_html_e( "Connecting again (a new code from Kindgi) replaces the site's key at Kindgi and signs everyone out there.", 'kindgi' ); ?></p>
		<?php endif; ?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="<?php echo esc_attr( self::CONNECT ); ?>">
			<?php wp_nonce_field( self::CONNECT ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="kindgi-code"><?php esc_html_e( 'One-time code', 'kindgi' ); ?></label></th>
					<td><input type="text" class="regular-text code" id="kindgi-code" name="kindgi_code" autocomplete="off" spellcheck="false" maxlength="200" required></td>
				</tr>
				<tr>
					<th scope="row"><label for="kindgi-url"><?php esc_html_e( 'Kindgi URL', 'kindgi' ); ?></label></th>
					<td>
						<?php if ( Kindgi_Settings::url_is_constant() ) : ?>
							<code><?php echo esc_html( Kindgi_Settings::url() ); ?></code>
							<p class="description"><?php esc_html_e( 'Set by KINDGI_URL in wp-config.php.', 'kindgi' ); ?></p>
						<?php else : ?>
							<input type="url" class="regular-text" id="kindgi-url" name="kindgi_url" value="<?php echo esc_attr( Kindgi_Settings::url() ); ?>" placeholder="https://platform.kindgi.com" required>
							<p class="description"><?php esc_html_e( 'Where this server reaches Kindgi: your Kindgi administrator sends it with the code.', 'kindgi' ); ?></p>
						<?php endif; ?>
					</td>
				</tr>
			</table>
			<?php submit_button( $again ? __( 'Connect again', 'kindgi' ) : __( 'Connect', 'kindgi' ), $again ? 'secondary' : 'primary' ); ?>
		</form>
		<?php
	}

	/**
	 * The agents staff see on the Ask page: each of the project's agents,
	 * ticked when offered. Kindgi still decides who may ask an agent at
	 * all. The form is drawn here, its nonce with it; the page's script
	 * fills in the agents from Kindgi (`kindgi-settings.js`), so Settings
	 * never waits on Kindgi.
	 */
	private static function offer_form(): void {
		$chosen = null !== Kindgi_Rest::offered();
		?>
		<p><?php esc_html_e( 'Staff see these on the Ask page. An agent that works on its own, from a webhook or a schedule, needn\'t be one: leave it unticked.', 'kindgi' ); ?></p>
		<form id="kindgi-offer" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="<?php echo esc_attr( self::OFFER ); ?>">
			<?php wp_nonce_field( self::OFFER ); ?>
			<fieldset>
				<legend class="screen-reader-text"><?php esc_html_e( 'Agents offered to staff', 'kindgi' ); ?></legend>
				<div class="kindgi-offer-list" aria-live="polite">
					<p class="description"><?php esc_html_e( "Asking Kindgi for the project's agents…", 'kindgi' ); ?></p>
					<noscript><p><?php esc_html_e( 'Choosing the agents needs JavaScript.', 'kindgi' ); ?></p></noscript>
				</div>
			</fieldset>
			<p class="description">
				<?php
				echo esc_html(
					$chosen
						? __( 'An agent deployed later is offered once you tick it here.', 'kindgi' )
						: __( 'All are offered, and so is any agent deployed later, until you untick one.', 'kindgi' )
				);
				?>
			</p>
			<?php submit_button( __( 'Save', 'kindgi' ), 'primary', 'submit', true, array( 'disabled' => 'disabled' ) ); ?>
		</form>
		<?php
	}

	/** The offered-agents form: every shown agent ticked offers all, now and later; otherwise the ticked ones. */
	public static function offer(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You may not choose the agents offered to staff.', 'kindgi' ), 403 );
		}
		check_admin_referer( self::OFFER );
		$ids    = static function ( string $field ): array {
			$values = isset( $_POST[ $field ] ) && is_array( $_POST[ $field ] ) ? wp_unslash( $_POST[ $field ] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- each is checked below.
			return array_values( array_unique( array_filter( array_map( 'strval', $values ), static function ( string $id ): bool {
				return 1 === preg_match( '/^' . Kindgi_Rest::ID . '$/', $id );
			} ) ) );
		};
		$shown = $ids( 'kindgi_shown' );
		if ( array() === $shown ) {
			// The agents never loaded: what's offered stays as it was.
			self::done( 'error', __( "Nothing was saved: Kindgi's list of agents hadn't loaded. Try again.", 'kindgi' ) );
		}
		$offered = self::offered_after( $shown, $ids( 'kindgi_agents' ) );
		if ( null === $offered ) {
			delete_option( Kindgi_Rest::OFFERED );
		} else {
			update_option( Kindgi_Rest::OFFERED, $offered, false );
		}
		self::done( 'ok', __( 'Saved: staff see the ticked agents on the Ask page.', 'kindgi' ) );
	}

	/**
	 * What the form offers: null (all, now and later) when every agent it
	 * showed is ticked, else the ticked ones, none included.
	 *
	 * @param string[] $shown  The agents the form showed, at least one.
	 * @param string[] $ticked The ones ticked.
	 * @return string[]|null
	 */
	public static function offered_after( array $shown, array $ticked ): ?array {
		return array() === array_diff( $shown, $ticked ) ? null : $ticked;
	}

	/** The connect form: the site's public key goes to Kindgi with the one-time code. */
	public static function connect(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You may not connect this site to Kindgi.', 'kindgi' ), 403 );
		}
		check_admin_referer( self::CONNECT );
		// The URL is kept only once Kindgi takes the code: a typo never breaks a working connection.
		$url = Kindgi_Settings::url();
		if ( ! Kindgi_Settings::url_is_constant() ) {
			$url = rtrim( esc_url_raw( trim( wp_unslash( (string) ( $_POST['kindgi_url'] ?? '' ) ) ), array( 'https', 'http' ) ), '/' );
		}
		if ( '' === $url || ! Kindgi_Settings::url_allowed( $url ) ) {
			self::done( 'error', __( "Kindgi's URL must be https://. An http:// URL works only on this computer (localhost) or from a local or development site.", 'kindgi' ) );
		}
		$code = sanitize_text_field( wp_unslash( (string) ( $_POST['kindgi_code'] ?? '' ) ) );
		if ( '' === $code || strlen( $code ) > 200 ) {
			self::done( 'error', __( 'Paste the one-time code from Kindgi.', 'kindgi' ) );
		}
		if ( Kindgi_Keys::configured() ) {
			$seed = Kindgi_Keys::seed();
			if ( ! is_string( $seed ) ) {
				self::done( 'error', is_wp_error( $seed ) ? $seed->get_error_message() : __( "The site's key couldn't be read.", 'kindgi' ) );
			}
		} else {
			// A new key each time: connecting again is how the plugin's own key is replaced.
			$seed = Kindgi_Keys::generate();
		}
		$jwk      = Kindgi_Keys::jwk( $seed );
		$response = Kindgi_Http::request(
			'POST',
			'/v1/auth/sites/enroll',
			array(),
			array(
				'code'      => $code,
				'publicKey' => $jwk,
			),
			null,
			$url
		);
		if ( is_wp_error( $response ) ) {
			self::done( 'error', $response->get_error_message() );
		}
		if ( 200 !== $response['status'] ) {
			self::done( 'error', Kindgi_Http::error( $response )->get_error_message() );
		}
		$body = (array) $response['body'];
		if ( ! is_string( $body['siteId'] ?? null ) || ! is_string( $body['audience'] ?? null ) ) {
			self::done( 'error', __( "Kindgi's answer to connecting wasn't one.", 'kindgi' ) );
		}
		if ( ! Kindgi_Keys::configured() ) {
			Kindgi_Keys::keep( $seed );
		}
		if ( ! Kindgi_Settings::url_is_constant() ) {
			update_option( Kindgi_Settings::URL_OPTION, $url, true );
		}
		Kindgi_Settings::keep_site(
			array(
				'site_id'     => $body['siteId'],
				'audience'    => $body['audience'],
				'kid'         => $jwk['kid'],
				'origin'      => Kindgi_Settings::home_origin(),
				'enrolled_at' => time(),
			)
		);
		// Kindgi ended the site's sessions: so do the copies kept here.
		Kindgi_Sessions::forget_all();
		self::done( 'ok', __( 'Connected: your staff can use the Kindgi pages now.', 'kindgi' ) );
	}

	/** WooCommerce webhooks to Kindgi that WooCommerce turned off, each with the way back on. */
	private static function webhooks_off(): void {
		$off = Kindgi_Webhooks::off();
		if ( array() === $off ) {
			return;
		}
		$when = get_option( 'date_format' ) . ' ' . get_option( 'time_format' );
		echo '<div class="notice notice-error inline"><p><strong>' . esc_html__( 'WooCommerce turned off a webhook that delivers to Kindgi.', 'kindgi' ) . '</strong> '
			. esc_html__( "It does that after 7 refused deliveries in a row, and where Kindgi limits webhook receives, it refuses deliveries past the limit (429, try again later). Until it's on again, nothing it sends reaches Kindgi, and WooCommerce never resends what it didn't deliver.", 'kindgi' )
			. '</p><ul>';
		foreach ( $off as $webhook ) {
			echo '<li><a href="' . esc_url( Kindgi_Webhooks::edit_url( $webhook['id'] ) ) . '">' . esc_html( '' !== $webhook['name'] ? $webhook['name'] : '#' . $webhook['id'] ) . '</a>';
			if ( null !== $webhook['since'] ) {
				/* translators: %s: when WooCommerce turned the webhook off */
				echo ' ' . esc_html( sprintf( __( '(off since %s)', 'kindgi' ), (string) wp_date( $when, $webhook['since'] ) ) );
			}
			if ( current_user_can( 'manage_woocommerce' ) ) {
				echo ' <form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline">';
				echo '<input type="hidden" name="action" value="' . esc_attr( Kindgi_Webhooks::ENABLE ) . '">';
				echo '<input type="hidden" name="webhook" value="' . esc_attr( (string) $webhook['id'] ) . '">';
				wp_nonce_field( Kindgi_Webhooks::ENABLE );
				echo '<button type="submit" class="button button-small">' . esc_html__( 'Turn it on again', 'kindgi' ) . '</button></form>';
			}
			echo '</li>';
		}
		echo '</ul></div>';
	}

	/** People whose changes haven't reached Kindgi yet: wp-cron keeps trying. */
	private static function waiting(): void {
		$waiting = Kindgi_People::waiting();
		if ( array() === $waiting ) {
			return;
		}
		$when = get_option( 'date_format' ) . ' ' . get_option( 'time_format' );
		echo '<h2 id="kindgi-waiting">' . esc_html__( 'Waiting to reach Kindgi', 'kindgi' ) . '</h2>';
		echo '<p>' . esc_html__( "Kindgi hasn't heard about these changes yet. Until it does, these people keep what they had there. WordPress tries again on its own (wp-cron), less often each time, and never gives up.", 'kindgi' ) . '</p>';
		echo '<table class="widefat striped"><thead><tr>';
		foreach ( array( __( 'Who', 'kindgi' ), __( 'Change', 'kindgi' ), __( 'Tries', 'kindgi' ), __( 'Last answer', 'kindgi' ), __( 'Next try', 'kindgi' ) ) as $heading ) {
			echo '<th scope="col">' . esc_html( $heading ) . '</th>';
		}
		echo '</tr></thead><tbody>';
		foreach ( $waiting as $row ) {
			echo '<tr><td>' . esc_html( $row['who'] ) . '</td><td>'
				. esc_html( $row['left'] ? __( 'Left this site', 'kindgi' ) : __( 'Roles changed', 'kindgi' ) ) . '</td><td>'
				. esc_html( (string) $row['tries'] ) . '</td><td>'
				. esc_html( $row['error'] ) . '</td><td>'
				. esc_html( (string) wp_date( $when, $row['due'] ) ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	/**
	 * What keeps a connected site from signing anyone in, in words.
	 *
	 * @return string[]
	 */
	private static function problems( array $site ): array {
		$problems = array();
		if ( Kindgi_Settings::home_origin() !== $site['origin'] ) {
			$problems[] = sprintf(
				/* translators: 1: the address the site connected as, 2: its address now */
				__( "This site connected as %1\$s and is now %2\$s, so it signs nobody in. If it moved, connect it again with a new code.", 'kindgi' ),
				$site['origin'],
				Kindgi_Settings::home_origin()
			);
		}
		$seed = Kindgi_Keys::seed();
		if ( is_wp_error( $seed ) ) {
			$problems[] = $seed->get_error_message();
		} elseif ( null === $seed || Kindgi_Keys::jwk( $seed )['kid'] !== $site['kid'] ) {
			$problems[] = __( "The site's key isn't the one it connected with, so it signs nobody in: connect it again with a new code.", 'kindgi' );
		}
		return $problems;
	}

	private static function key_status( string $source ): void {
		if ( 'constant' === $source || 'environment' === $source ) {
			echo esc_html(
				'constant' === $source
					? __( 'In wp-config.php (KINDGI_SITE_SECRET_KEY).', 'kindgi' )
					: __( 'In the environment (KINDGI_SITE_SECRET_KEY).', 'kindgi' )
			);
			self::key_id();
			echo '<p class="description">' . esc_html__( "The staff's Kindgi sessions, kept for up to 15 minutes, are sealed under a key made from it: a copy of the database opens none of them.", 'kindgi' ) . '</p>';
			return;
		}
		echo esc_html(
			'option' === $source
				? __( "In the database, where a copy of the database carries it, and with it the staff's Kindgi sessions. Connecting again replaces it.", 'kindgi' )
				: __( 'None yet: connecting makes one and keeps it in the database.', 'kindgi' )
		);
		self::key_id();
		echo '<p class="description">';
		printf(
			/* translators: 1: define( 'KINDGI_SITE_SECRET_KEY', '…' ); 2: the command that makes a key */
			esc_html__( 'Preferred: put the key in wp-config.php, %1$s, with one from %2$s, then connect (again).', 'kindgi' ),
			"<code>define( 'KINDGI_SITE_SECRET_KEY', '…' );</code>",
			"<code>php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'</code>"
		);
		echo '</p>';
	}

	/** The key's id, its RFC 7638 thumbprint: `kindgi sites get` lists the site's keys by it. */
	private static function key_id(): void {
		$kid = Kindgi_Keys::kid();
		if ( null === $kid ) {
			return;
		}
		echo '<p>';
		printf(
			/* translators: %s: the key's id */
			esc_html__( 'Key id (its thumbprint): %s', 'kindgi' ),
			'<code>' . esc_html( $kid ) . '</code>'
		);
		echo '</p>';
	}

	/**
	 * Back to the settings page, with a notice. Also `Kindgi_Webhooks`'s form.
	 *
	 * @return never
	 */
	public static function done( string $kind, string $message ): void {
		set_transient(
			self::notice_key(),
			array(
				'kind'    => $kind,
				'message' => $message,
			),
			60
		);
		wp_safe_redirect( admin_url( 'admin.php?page=' . self::SETTINGS_PAGE ) );
		exit;
	}

	private static function notice_key(): string {
		return 'kindgi_notice_' . get_current_user_id();
	}
}
