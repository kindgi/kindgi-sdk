// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The count of approvals waiting for the person, on the Kindgi menu and in
 * the admin bar, kept fresh by WordPress's heartbeat on every admin page.
 * The site asks Kindgi at most once a minute (`Kindgi_Inbox::count`); the
 * Inbox sends a `kindgi-count` event with the count it just listed.
 */
(($) => {
  const { _n, sprintf } = wp.i18n;

  /** Sets an element's text, when the page has it. */
  const say = (node, text) => {
    if (node !== null) node.textContent = text;
  };

  /** Shows the count, as WordPress's own bubbles do; nothing at 0. */
  function show(count) {
    if (!Number.isInteger(count) || count < 0) return;
    const words = sprintf(_n('%s waits for you', '%s wait for you', count, 'kindgi'), count);
    for (const bubble of document.querySelectorAll('.kindgi-count')) {
      bubble.className = bubble.className.replace(/\bcount-\d+\b/, `count-${count}`);
      say(bubble.querySelector('.pending-count'), String(count));
      say(bubble.querySelector('.screen-reader-text'), words);
    }
    const node = document.getElementById('wp-admin-bar-kindgi-inbox');
    if (node === null) return;
    node.classList.toggle('kindgi-none', count === 0);
    say(node.querySelector('.kindgi-count-label'), String(count));
    say(node.querySelector('.kindgi-count-words'), words);
  }

  $(document)
    .on('heartbeat-send', (_event, data) => {
      data.kindgi_inbox = 1;
    })
    .on('heartbeat-tick', (_event, data) => {
      show(data.kindgi_inbox);
    });
  document.addEventListener('kindgi-count', (event) => show(event.detail));
})(jQuery);
