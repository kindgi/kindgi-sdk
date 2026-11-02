// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi box on a WooCommerce order's screen (`Kindgi_Order::box`):
 * the approvals about the order that wait, to decide here as in the
 * Inbox; the mail replies to the order's customer; then those about the
 * order that closed, with who decided. Opening an order signs no one in
 * at Kindgi: without a live session the box says so, and asks Kindgi
 * when the person says to. Text from Kindgi or WordPress is only ever
 * set as text, never as HTML.
 */
(() => {
  const root = document.getElementById('kindgi-order-app');
  if (root === null) return;
  const { __, sprintf } = wp.i18n;
  const { api, el, notice, loading, muted, approvalCard } = window.kindgiCards;
  const order = root.dataset.order;
  const urls = window.kindgiConfig?.urls ?? {};

  /** A new conversation on the Ask page, its first words naming the order. */
  const askAbout = () =>
    el(
      'p',
      { className: 'kindgi-order-ask' },
      el(
        'a',
        { className: 'button', href: `${urls.ask}&order=${encodeURIComponent(order)}` },
        __('Ask about this order', 'kindgi'),
      ),
    );

  /**
   * The agent's replies to whoever placed the order, waiting first: a
   * mail tool's reply doesn't say what order it's about, so they show
   * apart, by the address they go to.
   */
  function mailTo(customer, card) {
    const mail = [...customer.waiting, ...customer.closed];
    if (mail.length === 0) return null;
    return [
      el('h3', { className: 'kindgi-order-section' }, __('Mail to this customer', 'kindgi')),
      muted(
        /* translators: %s: the order's billing email address */
        sprintf(
          __("The agent's replies to %s, the order's billing email.", 'kindgi'),
          customer.email,
        ),
      ),
      mail.map(card),
    ];
  }

  /** The box, from the person's live session; with `signIn`, signed in first if they have none. */
  async function show(signIn = false) {
    root.replaceChildren(loading());
    let answer;
    try {
      answer = await api(`/orders/${encodeURIComponent(order)}${signIn ? '?signIn=true' : ''}`);
    } catch (error) {
      root.replaceChildren(notice(error));
      return;
    }
    if (!answer.signedIn) {
      root.replaceChildren(
        el(
          'div',
          {},
          muted(
            __(
              "Opening an order doesn't sign you in to Kindgi, so the box hasn't asked it.",
              'kindgi',
            ),
          ),
          el(
            'p',
            {},
            el(
              'button',
              { type: 'button', className: 'button', onclick: () => show(true) },
              __('Show what Kindgi has for this order', 'kindgi'),
            ),
          ),
          askAbout(),
        ),
      );
      return;
    }
    // A decision made here moves its card to Decided, as Kindgi has it then.
    const card = (c) => approvalCard(c, { after: () => show(), inOrder: true });
    const { customer } = answer;
    root.replaceChildren(
      el(
        'div',
        {},
        answer.waiting.length === 0 && customer.waiting.length === 0
          ? muted(__('Nothing about this order waits for a decision.', 'kindgi'))
          : answer.waiting.map(card),
        mailTo(customer, card),
        answer.closed.length === 0
          ? null
          : [
              el('h3', { className: 'kindgi-order-section' }, __('Decided', 'kindgi')),
              answer.closed.map(card),
            ],
        answer.more
          ? muted(
              __(
                'The box looks through one page of approvals of each kind: the Inbox lists them all.',
                'kindgi',
              ),
            )
          : null,
        askAbout(),
      ),
    );
  }

  show();
})();
