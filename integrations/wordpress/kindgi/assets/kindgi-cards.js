// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What every Kindgi page in wp-admin draws an approval with, the Inbox and
 * the WooCommerce order's Kindgi box alike: an approval's card (what would
 * happen, in words, who asked and by when, then its decision, why it's
 * someone else's, or Approve and Reject) and the helpers it's made with,
 * as `window.kindgiCards`. Every call goes to this site's own routes
 * (`/wp-json/kindgi/v1/…`). Text from Kindgi or WordPress is only ever set
 * as text, never as HTML.
 */
(() => {
  const { __, sprintf } = wp.i18n;
  // Read when a link is made: the page sets its config before or after this script.
  const urls = () => window.kindgiConfig?.urls ?? {};

  const api = (path, options = {}) => wp.apiFetch({ path: `/kindgi/v1${path}`, ...options });

  const absent = (value) => value === undefined || value === null || value === false;

  /** One attribute: `on…` a listener, `className` the class, `true` a bare attribute. */
  function setAttribute(node, key, value) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'className') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }

  /** An element with attributes and children; strings become text nodes. */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (!absent(value)) setAttribute(node, key, value);
    }
    for (const child of children.flat(Number.POSITIVE_INFINITY)) {
      if (absent(child)) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  // The site's own date format and time zone (Settings → General).
  const when = (iso) => (iso ? wp.date.dateI18n(wp.date.getSettings().formats.datetime, iso) : '');
  /** Why Kindgi wouldn't sign the person in (its `reason`), in words for them. */
  const SIGN_IN = {
    'role-not-allowed': __(
      "Your role on this site doesn't use Kindgi. An administrator can change which roles do.",
      'kindgi',
    ),
    'person-removed': __(
      'You were removed from Kindgi on this site. An administrator can bring you back.',
      'kindgi',
    ),
    'people-cap': __(
      'This site has as many people at Kindgi as it may have. An administrator can make room.',
      'kindgi',
    ),
    'site-paused': __(
      'Kindgi is paused for this site. An administrator can turn it back on.',
      'kindgi',
    ),
  };
  const CLOCK = ['expired', 'issued-in-the-future', 'too-long-lived'];

  /** A sign-in Kindgi refused, in words for the person. */
  function signInFailure(reason) {
    if (SIGN_IN[reason] !== undefined) return SIGN_IN[reason];
    if (CLOCK.includes(reason)) {
      return __(
        "Kindgi didn't sign you in: this site's clock is off. Its host can set it right.",
        'kindgi',
      );
    }
    return __(
      "Kindgi didn't sign you in: this site's connection needs an administrator to connect it again.",
      'kindgi',
    );
  }

  /** Any other refusal, by its status. */
  const BY_STATUS = {
    400: __("Kindgi couldn't take that as it is.", 'kindgi'),
    403: __(
      "Kindgi doesn't let you do that here. An administrator decides what each role may do.",
      'kindgi',
    ),
    404: __("That isn't at Kindgi any more.", 'kindgi'),
    409: __('That changed meanwhile. Reload the page to see where it stands.', 'kindgi'),
    422: __("Kindgi couldn't take that as it is.", 'kindgi'),
    429: __('Kindgi is busy. Try again in a minute.', 'kindgi'),
  };

  /**
   * What went wrong, in words for staff. The plugin's own errors (`kindgi_…`)
   * are already worded for them; Kindgi's are its words for developers, so
   * they're replaced here and kept for administrators under Details.
   */
  function failure(error) {
    const code = String(error?.code ?? '');
    if (code.startsWith('kindgi_') && error?.message) return error.message;
    if (code === 'site-sign-in-refused') return signInFailure(error?.data?.reason);
    if (code === 'run-failed') {
      return __("The agent couldn't finish this. Try again, or ask it another way.", 'kindgi');
    }
    return (
      BY_STATUS[error?.data?.status] ??
      __("Kindgi can't be reached right now. Try again in a moment.", 'kindgi')
    );
  }

  /** Kindgi's own words about an error, for an administrator; null for anyone else. */
  function technical(error) {
    if (window.kindgiConfig?.admin !== true || String(error?.code ?? '').startsWith('kindgi_'))
      return null;
    const said = [error?.code, error?.message].filter(Boolean).join(': ');
    return said === ''
      ? null
      : el(
          'details',
          { className: 'kindgi-technical' },
          el('summary', {}, __('Details', 'kindgi')),
          el('code', {}, said),
        );
  }

  /** An error, in words for staff, with Try again when `retry` is given. */
  const notice = (error, retry = null) =>
    el(
      'div',
      { className: 'kindgi-problem', role: 'alert' },
      el('p', {}, failure(error)),
      retry === null
        ? null
        : el(
            'button',
            { type: 'button', className: 'button', onclick: retry },
            __('Try again', 'kindgi'),
          ),
      technical(error),
    );

  /** Grey lines where something is on its way; read out as "Loading…". */
  const loading = (lines = 3) =>
    el(
      'div',
      { className: 'kindgi-skeleton', role: 'status' },
      el('span', { className: 'screen-reader-text' }, __('Loading…', 'kindgi')),
      Array.from({ length: lines }, () =>
        el('span', { className: 'kindgi-skeleton-line', 'aria-hidden': 'true' }),
      ),
    );
  const muted = (text) => el('p', { className: 'kindgi-muted' }, text);

  /** A list with nothing in it: what it is, what lands in it, and what to do now. */
  const empty = ({ title, text = null, actions = [] }) =>
    el(
      'div',
      { className: 'kindgi-empty' },
      el('p', { className: 'kindgi-empty-title' }, title),
      text === null ? null : el('p', {}, text),
      actions.length === 0 ? null : el('p', { className: 'kindgi-empty-actions' }, actions),
    );

  /** A field's or a tool's name in words, `orderId` → "Order ID", as the site's PHP has it. */
  function words(name) {
    const spaced = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[\s_-]+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\bid\b/g, 'ID')
      .replace(/\burl\b/g, 'URL');
    return spaced === '' ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  /** A tool's id in words: its last part, `woo.refund-large` → "Refund large". */
  const toolName = (id) => (id ? words(id.split('.').pop()) : __('A tool', 'kindgi'));

  /**
   * A conversation's address on the Ask page; someone else's names the
   * approval it opens through, which its reader reviews.
   */
  const askUrl = (conversationId, approvalId = null) =>
    `${urls().ask}&conversation=${encodeURIComponent(conversationId)}${
      approvalId === null ? '' : `&approval=${encodeURIComponent(approvalId)}`
    }`;

  /** Who asked, in words: the card says it before when. */
  function askedWords(asked) {
    if (asked.kind === 'you') return __('You asked', 'kindgi');
    if (asked.kind === 'person') return sprintf(__('%s asked', 'kindgi'), asked.name);
    if (asked.kind === 'kindgi') return __('Asked from Kindgi', 'kindgi');
    return __('No person asked: a webhook, a schedule or a service key started it', 'kindgi');
  }

  /** How an approval closed without a person's approve or reject. */
  const CLOSED = {
    expired: __('Expired before anyone decided.', 'kindgi'),
    withdrawn: __('Withdrawn before anyone decided.', 'kindgi'),
    escalated: __('Passed on to another reviewer.', 'kindgi'),
  };

  /** Why a waiting approval isn't the person's to decide. */
  const NOT_YOURS = {
    'not-a-reviewer': __("Waits for a reviewer: you don't review approvals at Kindgi.", 'kindgi'),
    'you-asked': __('You asked for it, so another reviewer decides.', 'kindgi'),
    assigned: __('Waits for the reviewer it was assigned to.', 'kindgi'),
    'needs-senior': __('Waits for a senior reviewer.', 'kindgi'),
    'needs-admin': __('Waits for an admin reviewer.', 'kindgi'),
  };

  /**
   * One approval: what would happen, in words; who asked and by when it's
   * decided; then the decision, why it's someone else's, or Approve and
   * Reject. Kindgi's own words and ids are folded under Details.
   */
  function approvalCard(card, { after, inConversation = false, inOrder = false } = {}) {
    const kind = card.waitsFor ?? card.status;
    return el(
      'div',
      { className: `kindgi-card kindgi-${kind}`, 'data-approval': card.id },
      el('h3', {}, card.heading),
      card.summary ? el('p', {}, card.summary) : null,
      card.facts.length > 0
        ? el(
            'dl',
            { className: 'kindgi-facts' },
            card.facts.map((fact) => [el('dt', {}, fact.label), el('dd', {}, fact.value)]),
          )
        : null,
      card.words.map(agentWords),
      el(
        'p',
        { className: 'kindgi-muted' },
        askedWords(card.asked),
        `, ${when(card.createdAt)}`,
        card.waitsFor !== null && card.expiresAt
          ? [' · ', el('strong', {}, sprintf(__('Decide by %s', 'kindgi'), when(card.expiresAt)))]
          : null,
      ),
      cardLinks(card, inConversation, inOrder),
      cardEnding(card, after),
      details(card),
    );
  }

  /**
   * Where a card leads: its conversation, for whoever may read it, and the
   * order it's about, for someone who may edit orders (`orderUrl`). A card
   * on that page leaves its own link out.
   */
  function cardLinks(card, inConversation, inOrder) {
    const links = [
      inConversation || !card.opens
        ? null
        : el(
            'a',
            { href: askUrl(card.conversationId, card.id) },
            __('Open the conversation', 'kindgi'),
          ),
      inOrder || !card.orderUrl
        ? null
        : el('a', { href: card.orderUrl }, sprintf(__('Order #%s', 'kindgi'), card.about.id)),
    ].filter((link) => link !== null);
    if (links.length === 0) return null;
    return el(
      'p',
      { className: 'kindgi-links' },
      links.flatMap((link, i) => (i === 0 ? [link] : [' · ', link])),
    );
  }

  /** Words the agent wrote in its call (a reason, a note): quoted, and said to be its own. */
  const agentWords = (w) =>
    el(
      'figure',
      { className: 'kindgi-said' },
      el('figcaption', {}, sprintf(__("%s, in the agent's words", 'kindgi'), w.label)),
      el('blockquote', {}, w.text),
    );

  /** What a card ends with: the decision made, why it's someone else's, or the controls to make one. */
  function cardEnding(card, after) {
    if (card.decision !== null) return decisionLine(card.decision);
    if (card.waitsFor === null) {
      const closed = CLOSED[card.status];
      if (closed !== undefined) return el('p', { className: 'kindgi-note' }, closed);
      return el('p', {}, sprintf(__('This approval is %s.', 'kindgi'), card.status));
    }
    if (card.waitsFor !== 'you') {
      return el(
        'p',
        { className: 'kindgi-note' },
        NOT_YOURS[card.notYours] ?? __('Waits for another reviewer.', 'kindgi'),
      );
    }
    return decisionControls(card, after);
  }

  /** Kindgi's own words and ids for an approval, and the call's raw fields. */
  function details(card) {
    const d = card.details;
    const rows = [
      [__('Tool', 'kindgi'), d.toolId, true],
      [__('Agent', 'kindgi'), d.agentId, true],
      [__('Reviewer it needs', 'kindgi'), d.requiredRole, false],
      [__("Kindgi's title", 'kindgi'), d.title, false],
      [__('Approval', 'kindgi'), card.id, true],
    ].filter(([, value]) => value);
    return el(
      'details',
      { className: 'kindgi-details' },
      el('summary', {}, __('Details', 'kindgi')),
      el(
        'dl',
        { className: 'kindgi-facts' },
        rows.map(([label, value, code]) => [
          el('dt', {}, label),
          el('dd', {}, code ? el('code', {}, value) : value),
        ]),
      ),
      d.arguments === null || d.arguments === undefined
        ? null
        : el('pre', {}, JSON.stringify(d.arguments, null, 2)),
    );
  }

  /** What a decision did, once Kindgi recorded it. */
  function decided(done) {
    const line =
      done.approval.decision !== null ? decisionLine(done.approval.decision) : el('p', {}, '');
    if (done.waitpointResolved) return [line];
    return [
      line,
      muted(sprintf(__('The run had already moved on (%s).', 'kindgi'), done.runStatus ?? '')),
    ];
  }

  /** Approve, or reject with a reason. */
  function decisionControls(card, after) {
    const reason = el('textarea', {
      rows: '2',
      maxlength: '2000',
      'aria-label': __('Reason', 'kindgi'),
      placeholder: __('Why (needed to reject)', 'kindgi'),
    });
    const result = el('div', { 'aria-live': 'polite' });
    const buttons = el('p');
    const setDisabled = (disabled) => {
      for (const b of buttons.querySelectorAll('button')) b.disabled = disabled;
    };
    const decide = async (decision) => {
      if (decision === 'reject' && reason.value.trim() === '') {
        result.replaceChildren(
          notice({ code: 'kindgi_reason_needed', message: __('Say why you reject it.', 'kindgi') }),
        );
        reason.focus();
        return;
      }
      setDisabled(true);
      try {
        const done = await api(`/approvals/${encodeURIComponent(card.id)}/decide`, {
          method: 'POST',
          data: { decision, reason: reason.value.trim() },
        });
        result.replaceChildren(...decided(done));
        buttons.remove();
        reason.remove();
        // The count on the menu and in the admin bar, now rather than in a minute.
        window.wp?.heartbeat?.connectNow?.();
        if (after !== undefined) setTimeout(after, 1500);
      } catch (error) {
        setDisabled(false);
        result.replaceChildren(notice(error));
      }
    };
    buttons.append(
      el(
        'button',
        { type: 'button', className: 'button button-primary', onclick: () => decide('approve') },
        __('Approve', 'kindgi'),
      ),
      ' ',
      el(
        'button',
        { type: 'button', className: 'button', onclick: () => decide('reject') },
        __('Reject', 'kindgi'),
      ),
    );
    return el('div', {}, reason, buttons, result);
  }

  /** A decision in words, by who made it: you, a person here, or someone at Kindgi. */
  const DECIDED = {
    approve: {
      you: (at) => sprintf(__('Approved by you, %s', 'kindgi'), at),
      person: (at, name) => sprintf(__('Approved by %1$s, %2$s', 'kindgi'), name, at),
      kindgi: (at) => sprintf(__('Approved from Kindgi, %s', 'kindgi'), at),
    },
    reject: {
      you: (at) => sprintf(__('Rejected by you, %s', 'kindgi'), at),
      person: (at, name) => sprintf(__('Rejected by %1$s, %2$s', 'kindgi'), name, at),
      kindgi: (at) => sprintf(__('Rejected from Kindgi, %s', 'kindgi'), at),
    },
  };

  function decisionLine(decision) {
    const made = DECIDED[decision.decision === 'reject' ? 'reject' : 'approve'];
    let who = 'kindgi';
    if (decision.byMe) who = 'you';
    else if (decision.by) who = 'person';
    return el(
      'p',
      { className: 'kindgi-decision' },
      made[who](when(decision.decidedAt), decision.by),
      decision.reason ? `: ${decision.reason}` : '',
    );
  }

  window.kindgiCards = {
    api,
    el,
    when,
    notice,
    loading,
    muted,
    empty,
    toolName,
    askUrl,
    approvalCard,
  };
})();
