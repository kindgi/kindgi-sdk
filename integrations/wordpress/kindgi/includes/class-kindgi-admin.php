<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

defined( 'ABSPATH' ) || exit;

/**
 * The wp-admin side: the Kindgi page (Ask and Approvals), and the
 * settings page where an administrator connects the site with the
 * one-time code from Kindgi.
 */
final class Kindgi_Admin {

	/** The page's slug: an approval's link is `admin.php?page=kindgi&approval=<id>`. */
	const PAGE = 'kindgi';

	/** The settings page's slug. */
	const SETTINGS_PAGE = 'kindgi-settings';

	/** The connect form's action and nonce. */
	const CONNECT = 'kindgi_connect';

	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'menu' ) );
		add_action( 'admin_enqueue_scripts', array( self::class, 'assets' ) );
		add_action( 'admin_post_' . self::CONNECT, array( self::class, 'connect' ) );
	}

	/**
	 * Who sees the Kindgi page. Kindgi decides the rest from the person's
	 * roles on this site (a role it doesn't allow is refused there).
	 */
	public static function capability(): string {
		/**
		 * The capability the Kindgi page needs.
		 *
		 * @param string $capability Default `edit_posts`: shop managers and editors, never customers.
		 */
		return (string) apply_filters( 'kindgi_capability', 'edit_posts' );
	}

	public static function menu(): void {
		add_menu_page(
			__( 'Kindgi', 'kindgi' ),
			__( 'Kindgi', 'kindgi' ),
			self::capability(),
			self::PAGE,
			array( self::class, 'page' ),
			'dashicons-format-chat',
			58
		);
		add_submenu_page( self::PAGE, __( 'Kindgi', 'kindgi' ), __( 'Ask and approve', 'kindgi' ), self::capability(), self::PAGE, array( self::class, 'page' ) );
		add_submenu_page( self::PAGE, __( 'Kindgi settings', 'kindgi' ), __( 'Settings', 'kindgi' ), 'manage_options', self::SETTINGS_PAGE, array( self::class, 'settings' ) );
	}

	public static function assets( string $hook ): void {
		if ( 'toplevel_page_' . self::PAGE !== $hook ) {
			return;
		}
		$version = KINDGI_PLUGIN_VERSION;
		wp_enqueue_style( 'kindgi-admin', plugins_url( 'assets/kindgi-admin.css', KINDGI_PLUGIN_FILE ), array(), $version );
		wp_enqueue_script( 'kindgi-admin', plugins_url( 'assets/kindgi-admin.js', KINDGI_PLUGIN_FILE ), array( 'wp-api-fetch', 'wp-i18n' ), $version, true );
		wp_set_script_translations( 'kindgi-admin', 'kindgi' );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- a link to open, not an action.
		$approval = isset( $_GET['approval'] ) ? sanitize_text_field( wp_unslash( $_GET['approval'] ) ) : '';
		$config   = array(
			'approval' => preg_match( '/^' . Kindgi_Rest::ID . '$/', $approval ) ? $approval : null,
			'pollMs'   => 1500,
			'siteName' => get_bloginfo( 'name' ),
		);
		wp_add_inline_script( 'kindgi-admin', 'window.kindgiConfig = ' . wp_json_encode( $config ) . ';', 'before' );
	}

	public static function page(): void {
		echo '<div class="wrap kindgi"><h1>' . esc_html__( 'Kindgi', 'kindgi' ) . '</h1>';
		if ( null === Kindgi_Settings::site() ) {
			echo '<div class="notice notice-warning"><p>' . esc_html__( "This site isn't connected to Kindgi yet: an administrator connects it under Kindgi → Settings.", 'kindgi' ) . '</p></div></div>';
			return;
		}
		echo '<div id="kindgi-app"></div><noscript>' . esc_html__( 'The Kindgi page needs JavaScript.', 'kindgi' ) . '</noscript></div>';
	}

	public static function settings(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$site   = Kindgi_Settings::site();
		$source = Kindgi_Keys::source();
		$notice = get_transient( self::notice_key() );
		delete_transient( self::notice_key() );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Kindgi settings', 'kindgi' ); ?></h1>
			<?php if ( is_array( $notice ) ) : ?>
				<div class="notice notice-<?php echo 'ok' === $notice['kind'] ? 'success' : 'error'; ?>"><p><?php echo esc_html( $notice['message'] ); ?></p></div>
			<?php endif; ?>

			<h2><?php esc_html_e( 'This site', 'kindgi' ); ?></h2>
			<?php if ( null === $site ) : ?>
				<p><?php esc_html_e( 'Not connected yet. Register it in Kindgi first, on the project its staff will use, with these two addresses. Kindgi then gives you a one-time code to paste below.', 'kindgi' ); ?></p>
			<?php else : ?>
				<p>
					<?php
					printf(
						/* translators: 1: the site's id at Kindgi, 2: Kindgi's public URL */
						esc_html__( 'Connected as site %1$s, for %2$s.', 'kindgi' ),
						'<code>' . esc_html( $site['site_id'] ) . '</code>',
						'<code>' . esc_html( $site['audience'] ) . '</code>'
					);
					?>
				</p>
				<?php self::warnings( $site ); ?>
			<?php endif; ?>
			<table class="form-table" role="presentation">
				<tr><th scope="row"><?php esc_html_e( 'Origin', 'kindgi' ); ?></th><td><code><?php echo esc_html( Kindgi_Settings::home_origin() ); ?></code></td></tr>
				<tr><th scope="row"><?php esc_html_e( 'Approvals URL', 'kindgi' ); ?></th><td><code><?php echo esc_html( Kindgi_Settings::approvals_url() ); ?></code></td></tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Signing key', 'kindgi' ); ?></th>
					<td><?php self::key_status( $source ); ?></td>
				</tr>
			</table>

			<h2><?php echo esc_html( null === $site ? __( 'Connect', 'kindgi' ) : __( 'Connect again', 'kindgi' ) ); ?></h2>
			<?php if ( null !== $site ) : ?>
				<p><?php esc_html_e( "Connecting again (a new code from Kindgi) replaces the site's key at Kindgi and signs everyone out there.", 'kindgi' ); ?></p>
			<?php endif; ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="<?php echo esc_attr( self::CONNECT ); ?>">
				<?php wp_nonce_field( self::CONNECT ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="kindgi-url"><?php esc_html_e( 'Kindgi URL', 'kindgi' ); ?></label></th>
						<td>
							<?php if ( Kindgi_Settings::url_is_constant() ) : ?>
								<code><?php echo esc_html( Kindgi_Settings::url() ); ?></code>
								<p class="description"><?php esc_html_e( 'Set by KINDGI_URL in wp-config.php.', 'kindgi' ); ?></p>
							<?php else : ?>
								<input type="url" class="regular-text" id="kindgi-url" name="kindgi_url" value="<?php echo esc_attr( Kindgi_Settings::url() ); ?>" placeholder="https://kindgi.acme.example" required>
								<p class="description"><?php esc_html_e( 'Where this server reaches Kindgi.', 'kindgi' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="kindgi-code"><?php esc_html_e( 'One-time code', 'kindgi' ); ?></label></th>
						<td><input type="text" class="regular-text code" id="kindgi-code" name="kindgi_code" autocomplete="off" spellcheck="false" maxlength="200" required></td>
					</tr>
				</table>
				<?php submit_button( null === $site ? __( 'Connect', 'kindgi' ) : __( 'Connect again', 'kindgi' ) ); ?>
			</form>
		</div>
		<?php
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
		self::done( 'ok', __( 'Connected: your staff can use the Kindgi page now.', 'kindgi' ) );
	}

	/** What's wrong with a connected site, as notices. */
	private static function warnings( array $site ): void {
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
		foreach ( $problems as $problem ) {
			echo '<div class="notice notice-error inline"><p>' . esc_html( $problem ) . '</p></div>';
		}
	}

	private static function key_status( string $source ): void {
		if ( 'constant' === $source || 'environment' === $source ) {
			echo esc_html(
				'constant' === $source
					? __( 'In wp-config.php (KINDGI_SITE_SECRET_KEY).', 'kindgi' )
					: __( 'In the environment (KINDGI_SITE_SECRET_KEY).', 'kindgi' )
			);
			echo '<p class="description">' . esc_html__( "The staff's Kindgi sessions, kept for up to 15 minutes, are sealed under a key made from it: a copy of the database opens none of them.", 'kindgi' ) . '</p>';
			return;
		}
		echo esc_html(
			'option' === $source
				? __( "In the database, where a copy of the database carries it, and with it the staff's Kindgi sessions. Connecting again replaces it.", 'kindgi' )
				: __( 'None yet: connecting makes one and keeps it in the database.', 'kindgi' )
		);
		echo '<p class="description">';
		printf(
			/* translators: 1: define( 'KINDGI_SITE_SECRET_KEY', '…' ); 2: the command that makes a key */
			esc_html__( 'Preferred: put the key in wp-config.php, %1$s, with one from %2$s, then connect (again).', 'kindgi' ),
			"<code>define( 'KINDGI_SITE_SECRET_KEY', '…' );</code>",
			"<code>php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'</code>"
		);
		echo '</p>';
	}

	/**
	 * Back to the settings page with a notice.
	 *
	 * @return never
	 */
	private static function done( string $kind, string $message ): void {
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
