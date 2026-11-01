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

  /** Opens a conversation (or, with null, the agent's new one) and redraws the page. */
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

  async function renderAsk() {
    state.view += 1;
    root.replaceChildren(loading());
    let agents;
    let conversations;
    try {
      [agents, conversations] = await Promise.all([api('/agents'), api('/conversations')]);
    } catch (error) {
      root.replaceChildren(notice(error));
      return;
    }
    // Only the agents an administrator offered to staff (Kindgi → Settings).
    const offered = agents.agents.filter((a) => a.offered);
    const nameOf = (id) => agents.agents.find((a) => a.id === id)?.name || id;
    const about = el('p', { className: 'description kindgi-about' });
    const picker = el(
      'select',
      {
        id: 'kindgi-agent',
        onchange: () => {
          about.textContent = offered[Number(picker.value)]?.description ?? '';
        },
      },
      offered.map((a, i) => el('option', { value: String(i) }, a.name || a.id)),
    );
    about.textContent = offered[0]?.description ?? '';
    const startButton = el(
      'button',
      {
        type: 'button',
        className: 'button button-primary',
        disabled: offered.length === 0,
        // Opened at its first message, which names it.
        onclick: () => open(null, offered[Number(picker.value)]),
      },
      __('New conversation', 'kindgi'),
    );
    const item = (c) =>
      el(
        'li',
        {},
        inPage(
          askUrl(c.id),
          () => open(c.id),
          el(
            'span',
            { className: c.id === state.conversationId ? 'kindgi-current' : null },
            c.title || nameOf(c.agentId),
          ),
        ),
        el(
          'span',
          { className: 'kindgi-muted' },
          ` ${nameOf(c.agentId)} · ${when(c.lastMessageAt ?? c.openedAt)}`,
        ),
      );
    const list = el(
      'ul',
      { className: 'kindgi-conversations' },
      conversations.conversations.map(item),
    );
    // Someone else's open conversation, on a line of its own: it isn't in the person's list.
    const othersLine = el('p', { className: 'kindgi-muted', hidden: true });
    const side = el(
      'div',
      { className: 'kindgi-side' },
      el('label', { for: 'kindgi-agent' }, __('Agent', 'kindgi')),
      offered.length === 0 ? muted(__('No agent here you can ask.', 'kindgi')) : [picker, about],
      startButton,
      othersLine,
      el('h2', {}, __('Your conversations', 'kindgi')),
      conversations.conversations.length === 0 ? muted(__('None yet.', 'kindgi')) : null,
      list,
      olderButton('/conversations', conversations.nextCursor, (more) =>
        list.append(...more.conversations.map(item)),
      ),
    );
    const main = el('div', { className: 'kindgi-main' });
    root.replaceChildren(el('div', { className: 'kindgi-columns' }, side, main));
    // Asked about an order: a new conversation with the first agent offered, unless the person picks another.
    if (state.conversationId === null && state.newAgent === null && state.order !== null) {
      state.newAgent = offered[0] ?? null;
    }
    if (state.conversationId === null && state.newAgent === null) return;
    // The open conversation sets the agent, and shows in the list even when it's older.
    const follows = (conversation) => {
      const at = offered.findIndex((a) => a.id === conversation.agentId);
      if (at >= 0) {
        picker.value = String(at);
        about.textContent = offered[at].description;
      }
      if (conversation.mine === false) {
        othersLine.textContent = sprintf(
          __("Open: %s, someone else's", 'kindgi'),
          conversation.title || nameOf(conversation.agentId),
        );
        othersLine.hidden = false;
      } else if (
        conversation.id &&
        !conversations.conversations.some((c) => c.id === conversation.id)
      ) {
        list.prepend(item(conversation));
      }
    };
    renderConversation(main, nameOf, follows);
  }

  /** The first line of a message, as a conversation's title. */
  const titleOf = (text) => {
    const line = text.split('\n', 1)[0];
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  };

  /**
   * The open conversation, or a new one's empty page until its first
   * message. Someone else's (opened from an approval its reader reviews)
   * is shown to read, without the box to write in.
   */
  async function renderConversation(main, nameOf, follows) {
    const view = state.view;
    main.replaceChildren(loading());
    let conversation;
    let messages;
    try {
      [conversation, messages] = await loadConversation();
    } catch (error) {
      main.replaceChildren(notice(error));
      return;
    }
    if (view !== state.view) return;
    follows(conversation ?? { agentId: state.newAgent.id });
    const log = el(
      'ol',
      { className: 'kindgi-messages', 'aria-live': 'polite' },
      messages.messages.map(message).filter((m) => m !== null),
    );
    const progress = el('div', { className: 'kindgi-progress', 'aria-live': 'polite' });
    // In el, unlike replaceChildren alone, an absent child is skipped, not written as "null".
    main.replaceChildren(
      el(
        'div',
        {},
        conversationHead(conversation, nameOf),
        messages.earlier ? muted(__("Earlier messages aren't shown.", 'kindgi')) : null,
        log,
        progress,
        conversation === null || conversation.mine ? composer(log, progress, conversation) : null,
      ),
    );
    // A turn this page started is still running: follow it again.
    const running = state.running.get(state.conversationId);
    if (running !== undefined) await followTurn(state.conversationId, running, progress);
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

  /** The conversation's title, or a new one's agent; someone else's says it's there to read. */
  function conversationHead(conversation, nameOf) {
    if (conversation === null) {
      return muted(
        sprintf(
          __('A new conversation with %s.', 'kindgi'),
          state.newAgent.name || state.newAgent.id,
        ),
      );
    }
    return [
      el('h2', {}, conversation.title || nameOf(conversation.agentId)),
      conversation.mine
        ? null
        : el(
            'p',
            { className: 'kindgi-note' },
            __("Someone else's conversation: you can read it, not continue it.", 'kindgi'),
          ),
    ];
  }

  /** The box to write in, and Send; a new conversation about an order starts with its number. */
  function composer(log, progress, conversation) {
    const input = el('textarea', { id: 'kindgi-message', rows: '3', maxlength: '20000' });
    if (conversation === null && state.order !== null) {
      input.value = sprintf(__('About order #%s: ', 'kindgi'), state.order);
    }
    const send = el(
      'button',
      {
        type: 'button',
        className: 'button button-primary',
        onclick: () => sendTurn(input, send, log, progress),
      },
      __('Send', 'kindgi'),
    );
    return [
      el(
        'label',
        { for: 'kindgi-message', className: 'screen-reader-text' },
        __('Your message', 'kindgi'),
      ),
      input,
      send,
    ];
  }

  /** Sends a message: opens the conversation first when it's new, then follows the turn. */
  async function sendTurn(input, send, log, progress) {
    const text = input.value.trim();
    if (text === '') return;
    send.disabled = true;
    log.append(el('li', { className: 'kindgi-message kindgi-user' }, text));
    input.value = '';
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
      await followTurn(conversationId, turn.runId, progress);
    } catch (error) {
      progress.replaceChildren(notice(error));
      send.disabled = false;
    }
  }

  /** Follows a turn; when it ends (and the person is still here), redraws with its answer. */
  async function followTurn(conversationId, runId, progress) {
    const ended = await follow(runId, progress, state.view);
    if (!ended) return;
    state.running.delete(conversationId);
    if (state.conversationId === conversationId) renderAsk();
  }

  /** One message: words, the tools an agent called, or a tool's answer (its raw result a click away). */
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
            { className: 'kindgi-muted' },
            sprintf(__('Calls %s', 'kindgi'), m.calls.map(toolName).join(', ')),
          )
        : null;
    if (m.text === '' && calls === null) return null;
    return el(
      'li',
      { className: `kindgi-message kindgi-${m.role}` },
      m.text,
      m.text !== '' && calls ? ' ' : '',
      calls,
    );
  }

  /**
   * Follows a turn until it ends (true), or until the person moves on
   * (false): its tools, and what it waits for. While it waits for a person,
   * polls back off to every 30 s, and none run while the page is hidden.
   */
  async function follow(runId, progress, view) {
    let since = 0;
    let delay = pollMs;
    const steps = el('ul', { className: 'kindgi-steps' });
    const waits = el('div');
    const shown = new Map();
    progress.replaceChildren(steps, waits);
    for (;;) {
      await visible();
      if (view !== state.view) return false;
      const run = await api(`/runs/${encodeURIComponent(runId)}?since=${since}`);
      if (view !== state.view) return false;
      since = run.since;
      steps.append(
        ...run.steps.map((step) =>
          el('li', {}, sprintf(__('Called %s', 'kindgi'), toolName(step.toolId))),
        ),
      );
      showWaits(waits, shown, run.waitingFor);
      if (hasEnded(run, progress)) return true;
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
