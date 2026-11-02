<?php
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Plugin Name:       Kindgi
 * Plugin URI:        https://kindgi.com
 * Description:       Your store's staff ask your Kindgi agents and approve what they're about to do, in wp-admin, each as themselves.
 * Version:           0.1.1
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            Kindgi
 * Author URI:        https://kindgi.com
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       kindgi
 */

defined( 'ABSPATH' ) || exit;

define( 'KINDGI_PLUGIN_VERSION', '0.1.1' );
define( 'KINDGI_PLUGIN_FILE', __FILE__ );

require_once __DIR__ . '/includes/class-kindgi-statement.php';
require_once __DIR__ . '/includes/class-kindgi-box.php';
require_once __DIR__ . '/includes/class-kindgi-keys.php';
require_once __DIR__ . '/includes/class-kindgi-settings.php';
require_once __DIR__ . '/includes/class-kindgi-http.php';
require_once __DIR__ . '/includes/class-kindgi-sessions.php';
require_once __DIR__ . '/includes/class-kindgi-people.php';
require_once __DIR__ . '/includes/class-kindgi-webhooks.php';
require_once __DIR__ . '/includes/class-kindgi-api.php';
require_once __DIR__ . '/includes/class-kindgi-rest.php';
require_once __DIR__ . '/includes/class-kindgi-admin.php';

Kindgi_Rest::register();
Kindgi_Admin::register();
Kindgi_People::register();
Kindgi_Webhooks::register();
register_deactivation_hook( __FILE__, array( Kindgi_People::class, 'unschedule' ) );
