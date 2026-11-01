// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The count of approvals waiting for the person, on the Kindgi menu and in
 * the admin bar, kept fresh by WordPress's heartbeat on every admin page,
 * and on a store's Orders list, the orders whose approvals wait (the
 * "Kindgi" column, `Kindgi_Order`). The site asks Kindgi at most once a
 * minute (`Kindgi_Inbox::count`); the Inbox sends a `kindgi-count` event
 * with the count it just listed.
 */
(($) => {
  const { __, _n, sprintf } = wp.i18n;

  /** A column cell's words, as `Kindgi_Order::waits_words` has them. */
  const WAITS = {
    you: __('Waits for you', 'kindgi'),
    others: __('Waits for a reviewer', 'kindgi'),
  };

  /** Sets an element's text, when the page has it. */
  const say = (node, text) => {
    if (node !== null) node.textContent = text;
  };

  /**
   * Shows the count (`n`, and `more` when more may wait than one page
   * held: "12+"), as WordPress's own bubbles do; nothing at 0. Without
   * one (no live session, or Kindgi didn't answer), what shows stays.
   */
  function show(count) {
    if (count === null || typeof count !== 'object' || !Number.isInteger(count.n) || count.n < 0) {
      return;
    }
    showOrders(count.orders);
    const { n } = count;
    const text = count.more === true && n > 0 ? `${n}+` : String(n);
    const words = sprintf(_n('%s waits for you', '%s wait for you', n, 'kindgi'), text);
    for (const bubble of document.querySelectorAll('.kindgi-count')) {
      bubble.className = bubble.className.replace(/\bcount-\d+\b/, `count-${n}`);
      say(bubble.querySelector('.pending-count'), text);
      say(bubble.querySelector('.screen-reader-text'), words);
    }
    const node = document.getElementById('wp-admin-bar-kindgi-inbox');
    if (node === null) return;
    node.classList.toggle('kindgi-none', n === 0);
    say(node.querySelector('.kindgi-count-label'), text);
    say(node.querySelector('.kindgi-count-words'), words);
  }

  /** The Orders list's cells, by order: what waits about each (none is an empty map, `[]` from PHP). */
  function showOrders(orders) {
    if (orders === null || typeof orders !== 'object') return;
    for (const cell of document.querySelectorAll('.kindgi-order-waits[data-kindgi-order]')) {
      cell.textContent = WAITS[orders[cell.dataset.kindgiOrder]] ?? '';
      cell.classList.remove('kindgi-unknown');
    }
  }

  $(document)
    .on('heartbeat-send', (_event, data) => {
      data.kindgi_inbox = 1;
    })
    .on('heartbeat-tick', (_event, data) => {
      show(data.kindgi_inbox);
    });
  document.addEventListener('kindgi-count', (event) => show(event.detail));
  // An Orders list drawn with no count kept asks for one now, not at the next beat.
  if (document.querySelector('.kindgi-order-waits.kindgi-unknown') !== null) {
    $(() => window.wp?.heartbeat?.connectNow?.());
  }
})(jQuery);
