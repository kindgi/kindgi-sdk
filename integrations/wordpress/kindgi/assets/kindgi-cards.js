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

  /** "2 hours ago", "in 23 hours"; the site's date where WordPress has no words for it. */
  const ago = (iso) =>
    iso && typeof wp.date.humanTimeDiff === 'function' ? wp.date.humanTimeDiff(iso) : when(iso);

  /** A time in words, with the site's full date on hover. */
  const timeEl = (iso, text = ago(iso)) => el('time', { datetime: iso, title: when(iso) }, text);
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
  const CLOCK = ['expired', 'issued-in-the-future'];

  const UNREACHABLE = __("Kindgi can't be reached right now. Try again in a moment.", 'kindgi');
  const BETWEEN = __(
    'Something went wrong between this site and Kindgi. Try again; if it keeps happening, an administrator can look under Details.',
    'kindgi',
  );

  /** A sign-in Kindgi refused, in words for the person. */
  function signInFailure(reason) {
    if (SIGN_IN[reason] !== undefined) return SIGN_IN[reason];
    if (CLOCK.includes(reason)) {
      return __(
        "Kindgi didn't sign you in: this site's clock is off. Its host can set it right.",
        'kindgi',
      );
    }
    // Each sign-in is new: one Kindgi took for a replay goes on a second try.
    if (reason === 'replayed')
      return __("Kindgi didn't sign you in this time. Try again.", 'kindgi');
    // The site's own statement, made wrong: no one here can mend it but its developer.
    if (reason === 'too-long-lived') return BETWEEN;
    return __(
      "Kindgi didn't sign you in: this site's connection needs an administrator to connect it again.",
      'kindgi',
    );
  }

  /**
   * Errors worded for someone else: WordPress's own (the page lost the site,
   * or the site answered with no JSON), and the plugin's that pass on
   * WordPress's HTTP words, Kindgi's odd answer, or the key's setup.
   */
  const NOT_STAFF_WORDS = {
    fetch_error: __(
      "This page can't reach the site right now. Check the connection and try again.",
      'kindgi',
    ),
    invalid_json: BETWEEN,
    kindgi_unreachable: UNREACHABLE,
    kindgi_error: UNREACHABLE,
    kindgi_bad_answer: UNREACHABLE,
    kindgi_key_invalid: __(
      "Kindgi isn't set up right on this site. An administrator can see why under Details.",
      'kindgi',
    ),
  };

  /** Any other refusal, by its status. A 400 or 422 is the plugin's and Kindgi's to sort out, not staff's. */
  const BY_STATUS = {
    400: BETWEEN,
    403: __(
      "Kindgi doesn't let you do that here. An administrator decides what each role may do.",
      'kindgi',
    ),
    404: __("That isn't at Kindgi any more.", 'kindgi'),
    409: __('That changed meanwhile. Reload the page to see where it stands.', 'kindgi'),
    422: BETWEEN,
    429: __('Kindgi is busy. Try again in a minute.', 'kindgi'),
  };

  /** Whether an error's own words are for staff: the plugin's, other than those worded for someone else. */
  const staffWords = (code) => code.startsWith('kindgi_') && !Object.hasOwn(NOT_STAFF_WORDS, code);

  /**
   * What went wrong, in words for staff. The plugin's own errors (`kindgi_…`)
   * are mostly worded for them; the rest are words for developers, so
   * they're replaced here and kept for administrators under Details.
   */
  function failure(error) {
    const code = String(error?.code ?? '');
    if (staffWords(code) && error?.message) return error.message;
    if (Object.hasOwn(NOT_STAFF_WORDS, code)) return NOT_STAFF_WORDS[code];
    if (code === 'site-sign-in-refused') return signInFailure(error?.data?.reason);
    if (code === 'run-failed') {
      return __("The agent couldn't finish this. Try again, or ask it another way.", 'kindgi');
    }
    return BY_STATUS[error?.data?.status] ?? UNREACHABLE;
  }

  /** Kindgi's own words about an error, for an administrator; null for anyone else. */
  function technical(error) {
    if (window.kindgiConfig?.admin !== true || staffWords(String(error?.code ?? ''))) return null;
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

  /** A run's state: the tone its pill is drawn in, and its words. */
  const RUN_STATES = {
    completed: ['ok', __('Done', 'kindgi')],
    failed: ['err', __('Failed', 'kindgi')],
    cancelled: ['none', __('Cancelled', 'kindgi')],
    suspended: ['warn', __('Waiting', 'kindgi')],
    running: ['run', __('Running', 'kindgi')],
    pending: ['run', __('Running', 'kindgi')],
  };

  /** A run's state as a pill (Activity, the dashboard). */
  function runState(run) {
    const [tone, words] = RUN_STATES[run.status] ?? ['none', run.status];
    return el('span', { className: `kindgi-state kindgi-state-${tone}` }, words);
  }

  /** What a waiting run waits for: each approval it asked for, linked to its card in the Inbox. */
  const waitsFor = (run) =>
    run.waiting.map((wait) =>
      el(
        'p',
        { className: 'kindgi-run-waits' },
        __('Waits for approval:', 'kindgi'),
        ' ',
        el('a', { href: approvalUrl(wait.id) }, wait.heading),
      ),
    );

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

  /** A plain sentence, or null when there is none. */
  const sentence = (text) => (typeof text === 'string' && text.trim() !== '' ? text.trim() : null);

  /**
   * A tool call's step in words, by its answer (the tool's message), if one
   * came: until then the agent only asked to use the tool. Kindgi answers a
   * call that ran nothing in one of two shapes, which say why: `{ status:
   * 'denied', reason }` when the call wasn't allowed, in Kindgi's words,
   * and `{ status: 'rejected', rationale? }` when its approval was
   * rejected, in the reviewer's. Any other answer is the tool's own.
   */
  function stepWords(id, answer) {
    const name = toolName(id);
    if (answer === undefined) {
      /* translators: %s: a tool's name */
      return { ran: false, line: sprintf(__('Asked to use %s', 'kindgi'), name), why: null };
    }
    const result = answer.result;
    const fields =
      result !== null && typeof result === 'object' && !Array.isArray(result)
        ? Object.keys(result).sort().join()
        : '';
    if (fields === 'reason,status' && result.status === 'denied') {
      return {
        ran: false,
        /* translators: %s: a tool's name */
        line: sprintf(__("Couldn't use %s", 'kindgi'), name),
        why: sentence(result.reason),
      };
    }
    if ((fields === 'status' || fields === 'rationale,status') && result.status === 'rejected') {
      const rationale = sentence(result.rationale);
      return {
        ran: false,
        /* translators: %s: a tool's name */
        line: sprintf(__("Didn't use %s: its approval was rejected", 'kindgi'), name),
        why:
          rationale === null
            ? null
            : sprintf(
                /* translators: %s: the reason the reviewer gave */
                __('Reason: %s', 'kindgi'),
                rationale,
              ),
      };
    }
    /* translators: %s: a tool's name */
    return { ran: true, line: sprintf(__('Used %s', 'kindgi'), name), why: null };
  }

  /**
   * A conversation's address on the Ask page; someone else's names the
   * approval it opens through, which its reader reviews.
   */
  const askUrl = (conversationId, approvalId = null) =>
    `${urls().ask}&conversation=${encodeURIComponent(conversationId)}${
      approvalId === null ? '' : `&approval=${encodeURIComponent(approvalId)}`
    }`;

  /** An approval's address: its card in the Inbox, marked. */
  const approvalUrl = (approvalId) => `${urls().inbox}&approval=${encodeURIComponent(approvalId)}`;

  /** A run's address on Activity: its row, marked; with `output`, what it returned open beside it. */
  const runUrl = (runId, output = false) =>
    `${urls().activity}&run=${encodeURIComponent(runId)}${output ? '&show=output' : ''}`;

  /**
   * Who asked, in words: the card says it before when. With no person
   * recorded, the agent asked on its own, on a run a mail, a schedule or
   * a webhook started; a new version of an agent was asked for with a
   * key, at Kindgi.
   */
  function askedWords(card) {
    const { asked } = card;
    if (asked.kind === 'you') return __('You asked', 'kindgi');
    if (asked.kind === 'person') {
      /* translators: %s: a person's name */
      return sprintf(__('%s asked', 'kindgi'), asked.name);
    }
    if (asked.kind === 'kindgi' || card.pin !== null) return __('Asked from Kindgi', 'kindgi');
    if (card.agent === null) return __('An agent asked on its own', 'kindgi');
    return card.reply
      ? /* translators: %s: the agent's name */
        sprintf(__('%s asked while answering an email', 'kindgi'), card.agent)
      : /* translators: %s: the agent's name */
        sprintf(__('%s asked on its own', 'kindgi'), card.agent);
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
   * One approval: what would happen, in words; who asked, and what
   * happens if no one decides in time; then the decision, why it's
   * someone else's, or Approve and Reject. Ids only Kindgi reads stay off
   * it: the card's address names the approval.
   */
  function approvalCard(card, { after, inConversation = false, inOrder = false } = {}) {
    const kind = card.waitsFor ?? card.status;
    return el(
      'div',
      { className: `kindgi-card kindgi-${kind}`, 'data-approval': card.id },
      el(
        'div',
        { className: 'kindgi-card-head' },
        el('h3', {}, card.heading),
        inOrder ? null : orderChip(card),
      ),
      card.summary ? el('p', { className: 'kindgi-summary' }, card.summary) : null,
      card.facts.length > 0
        ? el(
            'dl',
            { className: 'kindgi-facts' },
            card.facts.map((fact) => [el('dt', {}, fact.label), el('dd', {}, fact.value)]),
          )
        : null,
      card.words.map(agentWords),
      wholeCall(card),
      cardMeta(card),
      deadline(card),
      inConversation || !card.opens
        ? null
        : el(
            'p',
            { className: 'kindgi-links' },
            el(
              'a',
              { href: askUrl(card.conversationId, card.id) },
              card.reply
                ? __('See the email and what the agent did', 'kindgi')
                : __('See what the agent did', 'kindgi'),
            ),
          ),
      cardEnding(card, after),
    );
  }

  /**
   * The whole call, folded, when the card's facts and words leave part of
   * it out: every field, each value whole, so whoever decides sees all
   * that would run.
   */
  function wholeCall(card) {
    if (!Array.isArray(card.whole)) return null;
    return el(
      'details',
      { className: 'kindgi-whole' },
      el('summary', {}, __('The whole call', 'kindgi')),
      el(
        'dl',
        { className: 'kindgi-facts' },
        card.whole.map((field) => [el('dt', {}, field.label), el('dd', {}, field.value)]),
      ),
    );
  }

  /**
   * The order a card is about, beside its heading: a link for someone who
   * may edit orders (`orderUrl`), else its number.
   */
  function orderChip(card) {
    if (card.about?.kind !== 'woocommerce.order') return null;
    /* translators: %s: the order's number */
    const label = sprintf(__('Order #%s', 'kindgi'), card.about.id);
    return card.orderUrl
      ? el('a', { className: 'kindgi-chip-link', href: card.orderUrl }, label)
      : el('span', { className: 'kindgi-chip-link' }, label);
  }

  /** Under an approval waiting less than this long to be decided, its time left shows as short. */
  const SOON_MS = 2 * 60 * 60 * 1000;

  /** Who asked, and when. */
  const cardMeta = (card) =>
    el('p', { className: 'kindgi-meta' }, askedWords(card), ' · ', timeEl(card.createdAt));

  /**
   * What happens if no one decides a waiting approval in time: Kindgi
   * passes it to the reviewer tier above (`card.next`), or, at the top,
   * it expires and what it asks for doesn't happen.
   */
  function deadline(card) {
    if (card.waitsFor === null || !card.expiresAt) return null;
    const left = Date.parse(card.expiresAt) - Date.now();
    const soon = ago(card.expiresAt);
    let words;
    if (left <= 0) {
      /* translators: %s: how long ago, in words, e.g. "5 minutes ago" */
      words = sprintf(__('Was due %s', 'kindgi'), soon);
    } else if (card.next === 'senior') {
      /* translators: %s: how soon, in words, e.g. "a day from now" */
      words = sprintf(__('Goes to a senior reviewer %s if no one decides', 'kindgi'), soon);
    } else if (card.next === 'admin') {
      /* translators: %s: how soon, in words, e.g. "a day from now" */
      words = sprintf(__('Goes to an admin reviewer %s if no one decides', 'kindgi'), soon);
    } else if (card.reply) {
      /* translators: %s: how soon, in words, e.g. "a day from now" */
      words = sprintf(__("Expires %s if no one decides, and the reply isn't sent", 'kindgi'), soon);
    } else {
      /* translators: %s: how soon, in words, e.g. "a day from now" */
      words = sprintf(__("Expires %s if no one decides, and it doesn't happen", 'kindgi'), soon);
    }
    return el(
      'p',
      {
        className: `kindgi-deadline${left < SOON_MS ? ' kindgi-soon' : ''}`,
        title: when(card.expiresAt),
      },
      words,
    );
  }

  /** Words the agent wrote in its call (a reason, a draft to a customer): set apart, and said to be its own. */
  function agentWords(w) {
    const long = w.text.length > LONG_WORDS || w.text.split('\n').length > LONG_LINES;
    const text = el('div', { className: 'kindgi-said-text' }, w.text);
    const node = el(
      'figure',
      { className: `kindgi-said${long ? ' kindgi-folded' : ''}` },
      /* translators: %s: what the words are, such as the reply */
      el('figcaption', {}, sprintf(__('%s, written by the agent', 'kindgi'), w.label)),
      text,
    );
    if (long) {
      const more = el(
        'button',
        {
          type: 'button',
          className: 'button-link',
          'aria-expanded': 'false',
          onclick: () => {
            const folded = node.classList.toggle('kindgi-folded');
            more.setAttribute('aria-expanded', String(!folded));
            more.textContent = folded ? __('Show all', 'kindgi') : __('Show less', 'kindgi');
          },
        },
        __('Show all', 'kindgi'),
      );
      node.append(more);
    }
    return node;
  }

  /**
   * Words longer than this, or over this many lines, show their start,
   * with Show all: a reply or a note of usual length is read whole before
   * anyone decides.
   */
  const LONG_WORDS = 3000;
  const LONG_LINES = 40;

  /** What a card ends with: the decision made, why it's someone else's, or the controls to make one. */
  function cardEnding(card, after) {
    if (card.decision !== null) return decisionLine(card.decision);
    if (card.waitsFor === null) {
      const closed = CLOSED[card.status];
      if (closed !== undefined) return el('p', { className: 'kindgi-note' }, closed);
      /* translators: %s: the approval's status, as Kindgi names it */
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

  /**
   * What a decision did, once Kindgi recorded it: what follows from it,
   * unless the run waiting on it had already ended. An approval no run
   * waits on (a new version of an agent) has no run to end.
   */
  function decided(done, words) {
    const made = done.approval.decision;
    const line = made !== null ? decisionLine(made) : el('p', {}, '');
    if (!done.waitpointResolved && done.runStatus !== null) {
      return [
        line,
        /* translators: %s: the run's status, as Kindgi names it */
        muted(sprintf(__('The run had already moved on (%s).', 'kindgi'), done.runStatus)),
      ];
    }
    const follows = made?.decision === 'reject' ? words.rejected : words.approved;
    return follows ? [line, muted(follows)] : [line];
  }

  /**
   * A new version of an agent: approving it puts it live, once Kindgi
   * checks nothing changed since it was asked for; rejecting it keeps the
   * version the agent runs now.
   */
  function pinWords({ agent }) {
    return {
      approve: __('Approve the update', 'kindgi'),
      reject: __("Don't update…", 'kindgi'),
      confirm: __("Don't update", 'kindgi'),
      label: __("Why it shouldn't update", 'kindgi'),
      effect: sprintf(
        /* translators: %s: the agent's name */
        __('%s keeps the version it runs now. Whoever asked sees it too.', 'kindgi'),
        agent,
      ),
      needed: __("Say why it shouldn't update.", 'kindgi'),
      /* translators: %s: the agent's name */
      rejected: sprintf(__('Not updated: %s keeps the version it runs now.', 'kindgi'), agent),
      approved: __('Kindgi updates it if nothing changed since it was asked for.', 'kindgi'),
    };
  }

  /**
   * What the decision says it does. A rejection doesn't end the agent's
   * turn: the agent reads the reason and may try again, and a call that
   * needs approval comes back as a new one. A reply that isn't sent goes nowhere:
   * the person it was to hears nothing from Kindgi. A new version of an
   * agent has words of its own (`pinWords`).
   */
  function decisionWords(card) {
    if (card.pin !== null) return pinWords(card.pin);
    const tryAgain = card.reply
      ? __(
          'The agent reads what you write here and may write a new reply, which comes back for approval.',
          'kindgi',
        )
      : __(
          'The agent reads what you write here and may try again. A call that needs approval comes back for it.',
          'kindgi',
        );
    if (card.reply) {
      return {
        approve: __('Approve and send', 'kindgi'),
        reject: __("Don't send…", 'kindgi'),
        confirm: __("Don't send", 'kindgi'),
        label: __("What should change, or why it shouldn't go", 'kindgi'),
        /* translators: 1: the address the reply was to go to, 2: that the agent may write a new reply */
        effect: sprintf(__('Nothing goes to %1$s. %2$s', 'kindgi'), card.reply.to, tryAgain),
        needed: __("Say what should change, or why it shouldn't go.", 'kindgi'),
        rejected: __('Not sent. If the agent writes a new reply, it comes to the Inbox.', 'kindgi'),
      };
    }
    const asker =
      card.asked.kind === 'none' ? '' : ` ${__('Whoever asked sees it too.', 'kindgi')}`;
    return {
      approve: __('Approve', 'kindgi'),
      reject: __('Reject…', 'kindgi'),
      confirm: __('Reject', 'kindgi'),
      label: __('Why you reject it', 'kindgi'),
      /* translators: %s: that the agent may try again */
      effect: sprintf(__("It doesn't happen. %s", 'kindgi'), tryAgain) + asker,
      needed: __('Say why you reject it.', 'kindgi'),
      rejected: __(
        "It doesn't happen. If the agent tries again with a call that needs approval, it comes to the Inbox.",
        'kindgi',
      ),
    };
  }

  /**
   * Approve, or Reject: the reason box opens only then, since a rejection
   * needs one and an approval doesn't. Both say what they do.
   */
  function decisionControls(card, after) {
    const words = decisionWords(card);
    const id = `kindgi-why-${card.id}`;
    const reason = el('textarea', {
      id,
      rows: '3',
      maxlength: '2000',
      'aria-describedby': `${id}-effect`,
    });
    const why = el(
      'div',
      { className: 'kindgi-why', hidden: true },
      el('label', { for: id }, words.label),
      el('p', { id: `${id}-effect`, className: 'kindgi-effect' }, words.effect),
      reason,
    );
    reason.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') rejecting(false);
    });
    const result = el('div', { 'aria-live': 'polite' });
    const buttons = el('p', { className: 'kindgi-actions' });
    const setDisabled = (disabled) => {
      for (const b of buttons.querySelectorAll('button')) b.disabled = disabled;
    };
    const decide = async (decision) => {
      if (decision === 'reject' && reason.value.trim() === '') {
        result.replaceChildren(notice({ code: 'kindgi_reason_needed', message: words.needed }));
        reason.focus();
        return;
      }
      setDisabled(true);
      try {
        const done = await api(`/approvals/${encodeURIComponent(card.id)}/decide`, {
          method: 'POST',
          // A reason typed for a rejection and then cancelled never goes with an approval.
          data: decision === 'reject' ? { decision, reason: reason.value.trim() } : { decision },
        });
        result.replaceChildren(...decided(done, words));
        buttons.remove();
        why.remove();
        // The count on the menu and in the admin bar, now rather than in a minute.
        window.wp?.heartbeat?.connectNow?.();
        if (after !== undefined) setTimeout(after, 1500);
      } catch (error) {
        setDisabled(false);
        result.replaceChildren(notice(error));
      }
    };
    const button = (label, className, onclick) =>
      el('button', { type: 'button', className, onclick }, label);
    const asking = [
      button(words.approve, 'button button-primary', () => decide('approve')),
      button(words.reject, 'button', () => rejecting(true)),
    ];
    const rejectingButtons = [
      button(words.confirm, 'button kindgi-reject', () => decide('reject')),
      button(__('Cancel', 'kindgi'), 'button-link', () => rejecting(false)),
    ];
    const rejecting = (on) => {
      why.hidden = !on;
      result.replaceChildren();
      buttons.replaceChildren(...(on ? rejectingButtons : asking));
      (on ? reason : asking[1]).focus();
    };
    buttons.append(...asking);
    return el('div', {}, why, buttons, result);
  }

  /** A decision in words, by who made it: you, a person here, or someone at Kindgi. */
  const DECIDED = {
    approve: {
      /* translators: %s: how long ago, such as 5 minutes ago */
      you: (at) => sprintf(__('Approved by you, %s', 'kindgi'), at),
      /* translators: 1: a person's name, 2: how long ago, such as 5 minutes ago */
      person: (at, name) => sprintf(__('Approved by %1$s, %2$s', 'kindgi'), name, at),
      /* translators: %s: how long ago, such as 5 minutes ago */
      kindgi: (at) => sprintf(__('Approved from Kindgi, %s', 'kindgi'), at),
    },
    reject: {
      /* translators: %s: how long ago, such as 5 minutes ago */
      you: (at) => sprintf(__('Rejected by you, %s', 'kindgi'), at),
      /* translators: 1: a person's name, 2: how long ago, such as 5 minutes ago */
      person: (at, name) => sprintf(__('Rejected by %1$s, %2$s', 'kindgi'), name, at),
      /* translators: %s: how long ago, such as 5 minutes ago */
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
      {
        className: `kindgi-decision kindgi-decision-${decision.decision === 'reject' ? 'reject' : 'approve'}`,
        title: when(decision.decidedAt),
      },
      made[who](ago(decision.decidedAt), decision.by),
      decision.reason ? `: ${decision.reason}` : '',
    );
  }

  window.kindgiCards = {
    api,
    el,
    when,
    ago,
    timeEl,
    notice,
    technical,
    loading,
    muted,
    empty,
    toolName,
    stepWords,
    askUrl,
    approvalUrl,
    runUrl,
    approvalCard,
    runState,
    waitsFor,
  };
})();
