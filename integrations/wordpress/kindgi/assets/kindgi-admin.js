// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi pages in wp-admin, one view each (`kindgiConfig.view`):
 * - Inbox: the approvals that wait for the person, those that wait for
 *   someone else (and why), and the project's decided ones;
 * - Activity: what the project's agents and flows did, whoever or whatever
 *   started it;
 * - Ask: the person's conversations with the agents offered to staff.
 * Every call goes to this site's own routes (`/wp-json/kindgi/v1/…`), which
 * call Kindgi as the signed-in person; no Kindgi token is ever in the browser.
 *
 * Text from Kindgi or WordPress is only ever set as text, never as HTML.
 */
(() => {
  const root = document.getElementById('kindgi-app');
  if (root === null) return;
  const { __, sprintf } = wp.i18n;
  const config = window.kindgiConfig ?? {};
  const urls = config.urls ?? {};
  const pollMs = config.pollMs ?? 1500;
  const ENDED = ['completed', 'failed', 'cancelled'];

  const { api, el, when, notice, loading, muted, empty, toolName, askUrl, approvalCard } =
    window.kindgiCards;
  const absent = (value) => value === undefined || value === null || value === false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Resolves once the page is visible: polling waits while it's in a background tab. */
  function visible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const shown = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', shown);
        resolve();
      };
      document.addEventListener('visibilitychange', shown);
    });
  }

  /** A link that, clicked, stays on the page: `go` draws what it names. */
  const inPage = (href, go, ...children) =>
    el(
      'a',
      {
        href,
        onclick: (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          window.history.replaceState(null, '', href);
          go();
        },
      },
      ...children,
    );

  /** "Show older": the list's next page, given to `append`. */
  function olderButton(path, firstCursor, append) {
    let cursor = firstCursor;
    if (cursor === null) return null;
    const button = el(
      'button',
      {
        type: 'button',
        className: 'button',
        onclick: async () => {
          button.disabled = true;
          try {
            const page = await api(`${path}?cursor=${encodeURIComponent(cursor)}`);
            append(page);
            cursor = page.nextCursor;
            if (cursor === null) button.remove();
            else button.disabled = false;
          } catch (error) {
            button.replaceWith(notice(error));
          }
        },
      },
      __('Show older', 'kindgi'),
    );
    return el('p', {}, button);
  }

  const state = {
    me: null,
    // The Inbox's list: `you`, `others` or `decided`.
    filter: null,
    conversationId: config.conversation ?? null,
    // On the Ask page: the approval someone else's conversation opens through.
    through: config.view === 'ask' ? (config.approval ?? null) : null,
    // A conversation to open with this agent at its first message.
    newAgent: null,
    // "Ask about this order": a new conversation whose first words name the order, until it's sent.
    order: config.view === 'ask' ? (config.order ?? null) : null,
    // Bumped by every redraw: a poll started before it stops.
    view: 0,
    // Each conversation's turn still running, by its run: followed again on return.
    running: new Map(),
  };

  async function start() {
    root.replaceChildren(loading());
    try {
      state.me = await api('/me');
    } catch (error) {
      root.replaceChildren(notice(error, start));
      return;
    }
    if (config.view === 'activity') renderActivity();
    else if (config.view === 'ask') renderAsk();
    else renderInbox();
  }

  // ---------- Inbox ----------

  const FILTERS = [
    ['you', __('Waits for you', 'kindgi')],
    ['others', __('Waits for others', 'kindgi')],
    ['decided', __('Decided', 'kindgi')],
  ];
  const filterUrl = (filter) => `${urls.inbox}&show=${filter}`;

  /** The list the Inbox opens on: the one asked for, else what waits for the person. */
  function firstFilter() {
    const asked = new URLSearchParams(window.location.search).get('show');
    if (FILTERS.some(([filter]) => filter === asked)) return asked;
    return state.me.reviewerRole === null ? 'others' : 'you';
  }

  /**
   * The Inbox's approvals: what waits, the decided ones when they're shown,
   * and, for a link from an email, which list holds it.
   */
  async function loadInbox(opened) {
    const page = await api('/approvals?view=waiting');
    const loaded = {
      waiting: page.approvals,
      more: page.more === true,
      decided: null,
      linked: null,
    };
    const there = loaded.waiting.find((a) => a.id === opened);
    if (there !== undefined) state.filter = there.waitsFor;
    else if (opened !== null) {
      loaded.decided = (await api('/approvals?view=decided')).approvals;
      if (loaded.decided.some((a) => a.id === opened)) state.filter = 'decided';
      // A link to an approval neither list holds: this one, whatever its state.
      else {
        loaded.linked = await api(`/approvals/${encodeURIComponent(opened)}`).catch((error) => ({
          error,
        }));
      }
    }
    if (state.filter === 'decided' && loaded.decided === null) {
      loaded.decided = (await api('/approvals?view=decided')).approvals;
    }
    return loaded;
  }

  function linkedCard(linked, reload) {
    if (linked === null) return null;
    return el(
      'div',
      { className: 'kindgi-linked' },
      el('h2', {}, __('From your link', 'kindgi')),
      linked.error !== undefined ? notice(linked.error) : approvalCard(linked, { after: reload }),
    );
  }

  async function renderInbox() {
    state.view += 1;
    root.replaceChildren(loading());
    const opened = config.approval ?? null;
    config.approval = null;
    state.filter ??= firstFilter();
    let loaded;
    try {
      loaded = await loadInbox(opened);
    } catch (error) {
      // Try again opens the linked approval too.
      config.approval = opened;
      root.replaceChildren(notice(error, () => renderInbox()));
      return;
    }
    const mine = loaded.waiting.filter((a) => a.waitsFor === 'you');
    const others = loaded.waiting.filter((a) => a.waitsFor === 'others');
    document.dispatchEvent(
      new CustomEvent('kindgi-count', { detail: { n: mine.length, more: loaded.more } }),
    );
    const reload = () => renderInbox();
    const list = { you: mine, others, decided: loaded.decided ?? [] }[state.filter];
    // More waits than one page held: the oldest show, and the counts say "12+".
    // "12+" when more may wait than the page held; none of yours on it reads "0".
    const counted = (n) => (loaded.more && n > 0 ? `${n}+` : String(n));
    root.replaceChildren(
      ...[
        linkedCard(loaded.linked, reload),
        filters({ you: counted(mine.length), others: counted(others.length), decided: null }),
        el(
          'div',
          { className: 'kindgi-cards' },
          state.filter === 'decided'
            ? muted(__("The project's latest decisions, whoever decided.", 'kindgi'))
            : null,
          list.length === 0 ? emptyInbox() : list.map((a) => approvalCard(a, { after: reload })),
        ),
      ].filter((child) => !absent(child)),
    );
    if (opened === null) return;
    const target = root.querySelector(`[data-approval="${CSS.escape(opened)}"]`);
    target?.classList.add('kindgi-target');
    target?.scrollIntoView({ block: 'center' });
  }

  /** The Inbox's lists, as WordPress's own list screens have them ("All (3) | Mine (1)"). */
  function filters(counts) {
    const item = ([filter, label], at) => {
      const link = inPage(
        filterUrl(filter),
        () => {
          state.filter = filter;
          renderInbox();
        },
        label,
        counts[filter] === null
          ? null
          : [' ', el('span', { className: 'count' }, `(${counts[filter]})`)],
      );
      if (filter === state.filter) {
        link.className = 'current';
        link.setAttribute('aria-current', 'page');
      }
      // The space after the bar is the one WordPress's own markup leaves between items.
      return el('li', {}, link, at < FILTERS.length - 1 ? ' | ' : null);
    };
    return el('ul', { className: 'subsubsub' }, FILTERS.map(item));
  }

  /** An Inbox list with nothing in it: what lands there, and where to go instead. */
  function emptyInbox() {
    if (state.filter === 'decided') {
      return empty({
        title: __('Nothing decided yet', 'kindgi'),
        text: __("Each approval's decision shows here: who decided, when, and why.", 'kindgi'),
      });
    }
    if (state.filter === 'others') {
      return empty({
        title: __('Nothing waits for anyone else', 'kindgi'),
        text: __('An approval that someone else decides shows here, with who that is.', 'kindgi'),
      });
    }
    if (state.me.reviewerRole === null) {
      return empty({
        title: __('No approvals are yours to decide', 'kindgi'),
        text: __(
          "You don't review approvals at Kindgi. An administrator decides who does.",
          'kindgi',
        ),
        actions: [el('a', { className: 'button', href: urls.ask }, __('Ask an agent', 'kindgi'))],
      });
    }
    return empty({
      title: __("You're all caught up", 'kindgi'),
      text: __(
        'When an agent wants your OK, for a refund past its limit or a reply to a customer, it waits here.',
        'kindgi',
      ),
      actions: [
        el(
          'a',
          { className: 'button button-primary', href: urls.ask },
          __('Ask an agent', 'kindgi'),
        ),
        ' ',
        el(
          'a',
          { className: 'button', href: urls.activity },
          __('See what the agents did', 'kindgi'),
        ),
      ],
    });
  }

  // ---------- Activity ----------

  /** Who or what started a run, in words: a person by name. */
  const STARTED = {
    you: __('You', 'kindgi'),
    kindgi: __('Someone using Kindgi', 'kindgi'),
    webhook: __('A webhook', 'kindgi'),
    schedule: __('A schedule', 'kindgi'),
    event: __('An event', 'kindgi'),
    mail: __('An email', 'kindgi'),
    key: __('A service key', 'kindgi'),
  };
  const startedWords = (by) => (by.kind === 'person' ? by.name : (STARTED[by.kind] ?? '—'));

  /** A run's state in words; Kindgi's own word for one this page has none for. */
  const STATUS = {
    completed: __('Done', 'kindgi'),
    cancelled: __('Cancelled', 'kindgi'),
    suspended: __('Waiting', 'kindgi'),
    running: __('Running', 'kindgi'),
    pending: __('Running', 'kindgi'),
  };

  /** A run's state: one waiting for an approval links to the Inbox; a failed one says why. */
  function statusWords(run) {
    if (run.waiting) return el('a', { href: urls.inbox }, __('Waits for an approval', 'kindgi'));
    if (run.status !== 'failed') return STATUS[run.status] ?? run.status;
    return [
      el('span', { className: 'kindgi-failed' }, __('Failed', 'kindgi')),
      run.failureMessage ? el('div', { className: 'kindgi-muted' }, run.failureMessage) : null,
    ];
  }

  /** A run's one-line summary: its agent's words quoted, or its fields as they are. */
  function summaryLine(run) {
    if (!run.summary) return null;
    return run.said
      ? el('div', {}, el('q', { className: 'kindgi-said' }, run.summary))
      : el('div', {}, run.summary);
  }

  function activityRow(run, nameOf) {
    const name = run.agentId !== null ? nameOf(run.agentId) : (run.flow ?? __('A run', 'kindgi'));
    return el(
      'tr',
      {},
      el('td', {}, when(run.createdAt)),
      el(
        'td',
        { className: 'column-primary' },
        el('strong', {}, name),
        summaryLine(run),
        run.conversationId
          ? el(
              'div',
              { className: 'row-actions visible' },
              el('a', { href: askUrl(run.conversationId) }, __('Open the conversation', 'kindgi')),
            )
          : null,
        run.output === null
          ? null
          : el('details', {}, el('summary', {}, __('Output', 'kindgi')), el('pre', {}, run.output)),
        run.private === 'orders'
          ? muted(__('What it found shows to people who can edit orders.', 'kindgi'))
          : null,
      ),
      el('td', {}, startedWords(run.startedBy)),
      el('td', {}, statusWords(run)),
    );
  }

  async function renderActivity() {
    state.view += 1;
    root.replaceChildren(loading());
    let agents;
    let page;
    try {
      [agents, page] = await Promise.all([api('/agents'), api('/activity')]);
    } catch (error) {
      root.replaceChildren(notice(error, () => renderActivity()));
      return;
    }
    const nameOf = (id) => agents.agents.find((a) => a.id === id)?.name || id;
    if (page.runs.length === 0) {
      root.replaceChildren(
        empty({
          title: __('Nothing yet', 'kindgi'),
          text: __(
            "What the agents and flows do shows here: each order they review, each mail they answer, each question they're asked.",
            'kindgi',
          ),
          actions: [
            el(
              'a',
              { className: 'button button-primary', href: urls.ask },
              __('Ask an agent', 'kindgi'),
            ),
          ],
        }),
      );
      return;
    }
    const body = el(
      'tbody',
      {},
      page.runs.map((run) => activityRow(run, nameOf)),
    );
    root.replaceChildren(
      ...[
        muted(
          __(
            "What the project's agents and flows did, newest first, whoever or whatever started it.",
            'kindgi',
          ),
        ),
        el(
          'table',
          { className: 'widefat striped kindgi-activity' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              [
                __('When', 'kindgi'),
                __('What', 'kindgi'),
                __('Started by', 'kindgi'),
                __('Status', 'kindgi'),
              ].map((heading) => el('th', { scope: 'col' }, heading)),
            ),
          ),
          body,
        ),
        olderButton('/activity', page.nextCursor, (more) =>
          body.append(...more.runs.map((run) => activityRow(run, nameOf))),
        ),
      ].filter((child) => !absent(child)),
    );
  }

  // ---------- Ask ----------

  /** Opens a conversation (or, with null, a new one) and redraws the page. */
  function open(conversationId, newAgent = null) {
    state.conversationId = conversationId;
    state.through = null;
    state.newAgent = newAgent;
    // The address names the open conversation: a reload opens it again.
    window.history.replaceState(
      null,
      '',
      conversationId === null ? urls.ask : askUrl(conversationId),
    );
    renderAsk();
  }

  /** Questions a store's staff often start with: each fills the box, to send as it is or change. */
  const STARTERS = [
    __('Which orders are still processing?', 'kindgi'),
    __('Has any order waited more than a day to ship?', 'kindgi'),
    __('What sold best this week?', 'kindgi'),
  ];

  /**
   * A new conversation's agent: the one that last answered the person, when
   * it's still offered; else the first offered.
   */
  function lastAsked(offered, conversations) {
    const answered = conversations.filter(
      (c) => c.lastMessageAt && offered.some((a) => a.id === c.agentId),
    );
    const latest = answered.reduce(
      (best, c) => (best === null || c.lastMessageAt > best.lastMessageAt ? c : best),
      null,
    );
    return offered.find((a) => a.id === latest?.agentId) ?? offered[0];
  }

  /** "2 hours ago"; the site's date where WordPress has no words for it. */
  const ago = (iso) =>
    iso && typeof wp.date.humanTimeDiff === 'function' ? wp.date.humanTimeDiff(iso) : when(iso);

  /**
   * Ask: the person's conversations beside the open one. With none open,
   * the page is a new conversation, ready to type in, with the first agent
   * offered until the person picks another.
   */
  async function renderAsk() {
    state.view += 1;
    root.replaceChildren(loading());
    let agents;
    let conversations;
    try {
      [agents, conversations] = await Promise.all([api('/agents'), api('/conversations')]);
    } catch (error) {
      root.replaceChildren(notice(error, () => renderAsk()));
      return;
    }
    // Only the agents an administrator offered to staff (Kindgi → Settings).
    const offered = agents.agents.filter((a) => a.offered);
    const nameOf = (id) => agents.agents.find((a) => a.id === id)?.name || id;
    if (state.conversationId === null && offered.length === 0) {
      root.replaceChildren(noAgents());
      return;
    }
    if (state.conversationId === null)
      state.newAgent ??= lastAsked(offered, conversations.conversations);
    const item = (c) =>
      el(
        'li',
        { className: c.id === state.conversationId ? 'kindgi-current' : null },
        inPage(
          askUrl(c.id),
          () => open(c.id),
          el('span', { className: 'kindgi-conversation-title' }, c.title || nameOf(c.agentId)),
          el(
            'span',
            { className: 'kindgi-muted' },
            `${nameOf(c.agentId)} · ${ago(c.lastMessageAt ?? c.openedAt)}`,
          ),
        ),
      );
    const list = el(
      'ul',
      { className: 'kindgi-conversations' },
      conversations.conversations.map(item),
    );
    // Someone else's open conversation, on a line of its own: it isn't in the person's list.
    const othersLine = el('p', { className: 'kindgi-muted', hidden: true });
    const rail = el(
      'nav',
      { className: 'kindgi-rail', 'aria-label': __('Your conversations', 'kindgi') },
      el(
        'button',
        {
          type: 'button',
          className: 'button kindgi-new',
          disabled: offered.length === 0,
          onclick: () => open(null),
        },
        __('New conversation', 'kindgi'),
      ),
      el('h2', {}, __('Your conversations', 'kindgi')),
      othersLine,
      conversations.conversations.length === 0
        ? muted(__('What you ask shows here, to come back to.', 'kindgi'))
        : null,
      list,
      olderButton('/conversations', conversations.nextCursor, (more) =>
        list.append(...more.conversations.map(item)),
      ),
    );
    const chat = el('section', { className: 'kindgi-chat' });
    root.replaceChildren(el('div', { className: 'kindgi-ask' }, chat, rail));
    // The open conversation shows in the list even when it's older.
    const follows = (conversation) => {
      if (conversation === null) return;
      if (conversation.mine === false) {
        othersLine.textContent = sprintf(
          __("Open: %s, someone else's", 'kindgi'),
          conversation.title || nameOf(conversation.agentId),
        );
        othersLine.hidden = false;
      } else if (!conversations.conversations.some((c) => c.id === conversation.id)) {
        list.prepend(item(conversation));
      }
    };
    renderConversation(chat, { nameOf, offered, follows });
  }

  /** Ask with no agent offered to staff: who offers one. */
  function noAgents() {
    return empty({
      title: __('No agent here to ask yet', 'kindgi'),
      text:
        urls.settings === null || urls.settings === undefined
          ? __('An administrator offers agents to staff, under Kindgi → Settings.', 'kindgi')
          : __('Offer agents to your staff in Settings, under Agents offered to staff.', 'kindgi'),
      actions:
        urls.settings === null || urls.settings === undefined
          ? []
          : [
              el(
                'a',
                { className: 'button button-primary', href: urls.settings },
                __('Open Settings', 'kindgi'),
              ),
            ],
    });
  }

  /** The first line of a message, as a conversation's title. */
  const titleOf = (text) => {
    const line = text.split('\n', 1)[0];
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  };

  /**
   * The open conversation, or a new one ready to type in. Someone else's
   * (opened from an approval its reader reviews) is shown to read, without
   * the box to write in.
   */
  async function renderConversation(chat, { nameOf, offered, follows }) {
    const view = state.view;
    chat.replaceChildren(loading());
    let conversation;
    let messages;
    try {
      [conversation, messages] = await loadConversation();
    } catch (error) {
      chat.replaceChildren(notice(error, () => renderAsk()));
      return;
    }
    if (view !== state.view) return;
    follows(conversation);
    const page = conversationPage(chat, conversation, messages, { nameOf, offered });
    chat.classList.toggle('kindgi-started', conversation !== null);
    chat.replaceChildren(...page.children);
    if (conversation === null) page.box.focus();
    else page.log.lastElementChild?.scrollIntoView({ block: 'nearest' });
    // A turn this page started is still running: follow it again.
    const running = state.running.get(state.conversationId);
    if (running !== undefined) await followTurn(state.conversationId, running, page.progress);
  }

  /**
   * What the chat shows: the conversation's head (or a new one's), its
   * messages, the box to write in when it's the person's own, and starters
   * for a new one.
   */
  function conversationPage(chat, conversation, messages, { nameOf, offered }) {
    const log = el(
      'ol',
      { className: 'kindgi-messages', 'aria-live': 'polite' },
      messages.messages.map(message).filter((m) => m !== null),
    );
    const progress = el('div', { className: 'kindgi-progress', 'aria-live': 'polite' });
    const fresh = conversation === null ? freshHead(state.newAgent) : null;
    const box =
      conversation === null || conversation.mine
        ? composer({
            log,
            progress,
            conversation,
            offered,
            onAgent: (agent) => fresh?.show(agent),
            onSend: () => chat.classList.add('kindgi-started'),
          })
        : null;
    const children = [
      el(
        'div',
        { className: 'kindgi-thread' },
        fresh === null ? conversationHead(conversation, nameOf) : fresh.node,
        messages.earlier ? muted(__("Earlier messages aren't shown.", 'kindgi')) : null,
        log,
        progress,
      ),
      box?.node,
      fresh === null ? null : starters(box.fill),
    ].filter((child) => !absent(child));
    return { log, progress, box, children };
  }

  /**
   * The open conversation and its newest messages, or none for a new one.
   * Someone else's opens through the approval named in the address.
   */
  function loadConversation() {
    if (state.conversationId === null) return [null, { messages: [], earlier: false }];
    const id = encodeURIComponent(state.conversationId);
    const through = state.through === null ? '' : `?approval=${encodeURIComponent(state.through)}`;
    return Promise.all([
      api(`/conversations/${id}${through}`),
      api(`/conversations/${id}/messages${through}`),
    ]);
  }

  /** A new conversation's top: whom it asks, and what that agent does. */
  function freshHead(agent) {
    const title = el('h2', {});
    const about = el('p', { className: 'kindgi-muted kindgi-about' });
    const show = (a) => {
      title.textContent = sprintf(__('Ask %s', 'kindgi'), a.name || a.id);
      about.textContent = a.description;
    };
    show(agent);
    return { node: el('div', { className: 'kindgi-fresh' }, title, about), show };
  }

  /** The conversation's title and agent; someone else's says it's there to read. */
  function conversationHead(conversation, nameOf) {
    return el(
      'div',
      { className: 'kindgi-thread-head' },
      el('h2', {}, conversation.title || nameOf(conversation.agentId)),
      el(
        'p',
        { className: 'kindgi-muted' },
        sprintf(__('With %s', 'kindgi'), nameOf(conversation.agentId)),
      ),
      conversation.mine
        ? null
        : el(
            'p',
            { className: 'kindgi-note' },
            __("Someone else's conversation: you can read it, not continue it.", 'kindgi'),
          ),
    );
  }

  /**
   * The box to write in. Enter sends and Shift+Enter starts a new line; it
   * grows with what's written. A new conversation picks its agent here,
   * and one about an order starts with its number.
   */
  function composer({ log, progress, conversation, offered, onAgent, onSend }) {
    const fit = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    };
    const input = el('textarea', {
      id: 'kindgi-message',
      rows: '2',
      maxlength: '20000',
      placeholder:
        conversation === null
          ? __('Ask about orders, products or customers…', 'kindgi')
          : __('Reply…', 'kindgi'),
      oninput: () => fit(),
      onkeydown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        if (!send.disabled) send.click();
      },
    });
    if (conversation === null && state.order !== null) {
      input.value = sprintf(__('About order #%s: ', 'kindgi'), state.order);
    }
    const send = el(
      'button',
      {
        type: 'button',
        className: 'button button-primary kindgi-send',
        onclick: () => sendTurn(input, send, log, progress, onSend),
      },
      __('Send', 'kindgi'),
    );
    const picker =
      conversation === null && offered.length > 1
        ? el(
            'select',
            {
              className: 'kindgi-agent',
              'aria-label': __('Agent', 'kindgi'),
              onchange: (event) => {
                state.newAgent = offered[Number(event.target.value)];
                onAgent(state.newAgent);
              },
            },
            offered.map((a, i) =>
              el(
                'option',
                { value: String(i), selected: a.id === state.newAgent.id },
                a.name || a.id,
              ),
            ),
          )
        : null;
    return {
      node: el(
        'div',
        { className: 'kindgi-composer' },
        el(
          'label',
          { for: 'kindgi-message', className: 'screen-reader-text' },
          __('Your message', 'kindgi'),
        ),
        input,
        el(
          'div',
          { className: 'kindgi-composer-bar' },
          picker,
          el(
            'span',
            { className: 'kindgi-hint' },
            __('Enter sends. Shift+Enter starts a new line.', 'kindgi'),
          ),
          send,
        ),
      ),
      focus: () => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
      fill: (text) => {
        input.value = text;
        fit();
        input.focus();
      },
    };
  }

  /** A new conversation's first questions, on a store: each fills the box. */
  function starters(fill) {
    if (config.store !== true) return null;
    return el(
      'div',
      { className: 'kindgi-starters' },
      STARTERS.map((text) =>
        el('button', { type: 'button', className: 'kindgi-chip', onclick: () => fill(text) }, text),
      ),
    );
  }

  /** Sends a message: opens the conversation first when it's new, then follows the turn. */
  async function sendTurn(input, send, log, progress, onSend) {
    const text = input.value.trim();
    if (text === '') return;
    send.disabled = true;
    onSend?.();
    log.append(el('li', { className: 'kindgi-message kindgi-user' }, text));
    input.value = '';
    input.dispatchEvent(new Event('input'));
    try {
      if (state.conversationId === null) {
        const agent = state.newAgent;
        const opened = await api('/conversations', {
          method: 'POST',
          data: { agentId: agent.id, agentVersion: agent.version, title: titleOf(text) },
        });
        state.conversationId = opened.id;
        state.newAgent = null;
        state.order = null;
        window.history.replaceState(null, '', askUrl(opened.id));
      }
      const conversationId = state.conversationId;
      const turn = await api(`/conversations/${encodeURIComponent(conversationId)}/turns`, {
        method: 'POST',
        data: { message: text },
      });
      state.running.set(conversationId, turn.runId);
      if ((await followTurn(conversationId, turn.runId, progress)) === 'failed') {
        again(input, send, text);
      }
    } catch (error) {
      progress.replaceChildren(notice(error));
      again(input, send, text);
    }
  }

  /** A turn that didn't go: its words back in the box, to send again as they are or changed. */
  function again(input, send, text) {
    if (input.value.trim() === '') {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    }
    send.disabled = false;
  }

  /**
   * Follows a turn to its end: its status, or null when the person moved
   * on. An answer redraws the conversation with it; a failed turn stays as
   * it is, saying why.
   */
  async function followTurn(conversationId, runId, progress) {
    const status = await follow(runId, progress, state.view);
    if (status === null) return null;
    state.running.delete(conversationId);
    if (status !== 'failed' && state.conversationId === conversationId) renderAsk();
    return status;
  }

  /** A line of an agent's words: **bold** and `code` as such, the rest as text. */
  function inline(line) {
    return line
      .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
      .filter((part) => part !== '')
      .map((part) => {
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          return el('strong', {}, part.slice(2, -2));
        }
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          return el('code', {}, part.slice(1, -1));
        }
        return part;
      });
  }

  const BULLET = /^\s*[-*•]\s+/;
  const NUMBERED = /^\s*\d+[.)]\s+/;
  const HEADING = /^\s*#{1,6}\s+/;

  /**
   * An agent's words with the little Markdown agents write: paragraphs,
   * lists, headings, **bold** and `code`. Built as elements, so nothing an
   * agent says is ever read as HTML.
   */
  function rich(text) {
    return text
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const lines = block.split('\n');
        if (lines.every((l) => BULLET.test(l))) {
          return el(
            'ul',
            {},
            lines.map((l) => el('li', {}, inline(l.replace(BULLET, '')))),
          );
        }
        if (lines.every((l) => NUMBERED.test(l))) {
          return el(
            'ol',
            {},
            lines.map((l) => el('li', {}, inline(l.replace(NUMBERED, '')))),
          );
        }
        if (lines.length === 1 && HEADING.test(lines[0])) {
          return el('p', {}, el('strong', {}, inline(lines[0].replace(HEADING, ''))));
        }
        return el(
          'p',
          {},
          lines.map((l, i) => (i === 0 ? inline(l) : [el('br'), inline(l)])),
        );
      });
  }

  /** One message: words, the tools an agent used, or a tool's answer (its raw result a click away). */
  function message(m) {
    if (m.role === 'tool') {
      return el(
        'li',
        { className: 'kindgi-message kindgi-tool' },
        el(
          'details',
          {},
          el('summary', {}, sprintf(__('%s answered', 'kindgi'), toolName(m.toolId))),
          el('pre', {}, JSON.stringify(m.result, null, 2)),
        ),
      );
    }
    if (m.role !== 'user' && m.role !== 'agent') return null;
    const calls =
      m.calls.length > 0
        ? el(
            'span',
            { className: 'kindgi-calls' },
            sprintf(__('Used %s', 'kindgi'), m.calls.map(toolName).join(', ')),
          )
        : null;
    if (m.text === '' && calls === null) return null;
    if (m.text === '') return el('li', { className: 'kindgi-message kindgi-used' }, calls);
    return el(
      'li',
      { className: `kindgi-message kindgi-${m.role}` },
      m.role === 'agent' ? rich(m.text) : m.text,
      calls,
    );
  }

  /**
   * Follows a turn until it ends (its status), or until the person moves on
   * (null): its tools, and what it waits for. While it waits for a person,
   * polls back off to every 30 s, and none run while the page is hidden.
   */
  async function follow(runId, progress, view) {
    let since = 0;
    let delay = pollMs;
    const steps = el('ul', { className: 'kindgi-steps' });
    const waits = el('div');
    const shown = new Map();
    // While it works: three dots and the tools it used so far.
    const working = el(
      'p',
      { className: 'kindgi-working' },
      el(
        'span',
        { className: 'kindgi-dots', 'aria-hidden': 'true' },
        el('span'),
        el('span'),
        el('span'),
      ),
      __('Working on it…', 'kindgi'),
    );
    progress.replaceChildren(working, steps, waits);
    for (;;) {
      await visible();
      if (view !== state.view) return null;
      const run = await api(`/runs/${encodeURIComponent(runId)}?since=${since}`);
      if (view !== state.view) return null;
      since = run.since;
      steps.append(
        ...run.steps.map((step) =>
          el('li', {}, sprintf(__('Used %s', 'kindgi'), toolName(step.toolId))),
        ),
      );
      showWaits(waits, shown, run.waitingFor);
      // Waiting for a person: the approval's box says so, not the dots.
      working.hidden = run.status === 'suspended';
      if (hasEnded(run, progress)) {
        working.remove();
        return run.status;
      }
      delay = nextDelay(run.status, delay);
      await sleep(delay);
    }
  }

  /** Whether the turn has ended; a failed one says why. */
  function hasEnded(run, progress) {
    if (!ENDED.includes(run.status)) return false;
    // Kindgi's words for why it failed are for an administrator, under Details.
    if (run.status === 'failed') {
      progress.append(notice({ code: 'run-failed', message: run.failureMessage }));
    }
    return true;
  }

  /** The next poll's wait: the base while the turn runs, doubling up to 30 s while it waits for a person. */
  const nextDelay = (status, delay) =>
    status === 'suspended' ? Math.min(Math.max(delay * 2, 3000), 30_000) : pollMs;

  /** The turn's waits: a new one gets its box once, a gone one loses it, the rest stay as they are. */
  function showWaits(container, shown, waiting) {
    const ids = new Set(waiting.map((w) => w.approvalId));
    for (const [id, box] of shown) {
      if (ids.has(id)) continue;
      box.remove();
      shown.delete(id);
    }
    for (const wait of waiting) {
      if (shown.has(wait.approvalId)) continue;
      const box = waitFor(wait);
      shown.set(wait.approvalId, box);
      container.append(box);
    }
  }

  /** A wait in a turn: for a reviewer, the approval's card; for anyone else, what it waits for. */
  function waitFor(wait) {
    const box = el(
      'div',
      { className: 'kindgi-wait' },
      el('p', {}, sprintf(__('Waiting for a person to approve: %s', 'kindgi'), wait.heading)),
    );
    if (state.me.reviewerRole !== null) {
      // The turn's own polling shows what happens after a decision.
      api(`/approvals/${encodeURIComponent(wait.approvalId)}`)
        .then((card) => box.replaceChildren(approvalCard(card, { inConversation: true })))
        .catch((error) => box.append(notice(error)));
    }
    return box;
  }

  start();
})();
