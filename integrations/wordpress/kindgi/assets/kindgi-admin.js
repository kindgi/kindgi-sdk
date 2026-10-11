// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi page in wp-admin: Ask (the person's conversations with the
 * project's agents) and Approvals (what waits for them to decide). Every
 * call goes to this site's own routes (`/wp-json/kindgi/v1/…`), which call
 * Kindgi as the signed-in person; no Kindgi token is ever in the browser.
 *
 * Text from Kindgi or WordPress is only ever set as text, never as HTML.
 */
(() => {
  const root = document.getElementById('kindgi-app');
  if (root === null) return;
  const { __, sprintf } = wp.i18n;
  const config = window.kindgiConfig ?? {};
  const pollMs = config.pollMs ?? 1500;
  const ENDED = ['completed', 'failed', 'cancelled'];

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

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const failure = (error) => error?.message ?? __('Something went wrong.', 'kindgi');
  const notice = (error) =>
    el(
      'div',
      { className: 'notice notice-error inline', role: 'alert' },
      el('p', {}, failure(error)),
    );

  const state = {
    me: null,
    tab: config.approval ? 'approvals' : 'ask',
    conversationId: null,
    // A conversation to open with this agent at its first message.
    newAgent: null,
  };

  // ---------- the shell: two tabs ----------

  const panels = {
    ask: el('div', { className: 'kindgi-panel' }),
    approvals: el('div', { className: 'kindgi-panel' }),
  };
  const tabs = el('nav', { className: 'nav-tab-wrapper', role: 'tablist' });

  function showTab(tab) {
    state.tab = tab;
    for (const button of tabs.querySelectorAll('button')) {
      const selected = button.dataset.tab === tab;
      button.classList.toggle('nav-tab-active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== tab;
    if (tab === 'approvals') renderApprovals();
    else renderAsk();
  }

  async function start() {
    root.append(el('p', { className: 'kindgi-muted' }, __('Signing you in to Kindgi…', 'kindgi')));
    try {
      state.me = await api('/me');
    } catch (error) {
      root.replaceChildren(notice(error));
      return;
    }
    const tabButton = (tab, label) =>
      el(
        'button',
        {
          type: 'button',
          className: 'nav-tab',
          role: 'tab',
          'data-tab': tab,
          onclick: () => showTab(tab),
        },
        label,
      );
    tabs.append(tabButton('ask', __('Ask', 'kindgi')));
    // The approvals surface is for reviewers; anyone else sees a wait in their turn instead.
    if (state.me.reviewerRole !== null)
      tabs.append(tabButton('approvals', __('Approvals', 'kindgi')));
    else if (state.tab === 'approvals') state.tab = 'ask';
    root.replaceChildren(tabs, panels.ask, panels.approvals);
    showTab(state.tab);
  }

  // ---------- Ask ----------

  async function renderAsk() {
    const panel = panels.ask;
    panel.replaceChildren(el('p', { className: 'kindgi-muted' }, __('Loading…', 'kindgi')));
    let agents;
    let conversations;
    try {
      [agents, conversations] = await Promise.all([api('/agents'), api('/conversations')]);
    } catch (error) {
      panel.replaceChildren(notice(error));
      return;
    }
    const nameOf = (id) => agents.agents.find((a) => a.id === id)?.name || id;
    const picker = el(
      'select',
      { id: 'kindgi-agent' },
      agents.agents.map((a, i) => el('option', { value: String(i) }, a.name || a.id)),
    );
    const startButton = el(
      'button',
      {
        type: 'button',
        className: 'button button-primary',
        disabled: agents.agents.length === 0,
        onclick: () => {
          // Opened at its first message, which names it.
          state.conversationId = null;
          state.newAgent = agents.agents[Number(picker.value)];
          renderAsk();
        },
      },
      __('New conversation', 'kindgi'),
    );
    const list = el(
      'ul',
      { className: 'kindgi-conversations' },
      conversations.conversations.map((c) =>
        el(
          'li',
          {},
          el(
            'button',
            {
              type: 'button',
              className: `button-link${c.id === state.conversationId ? ' kindgi-current' : ''}`,
              onclick: () => {
                state.conversationId = c.id;
                state.newAgent = null;
                renderAsk();
              },
            },
            c.title || nameOf(c.agentId),
          ),
          el(
            'span',
            { className: 'kindgi-muted' },
            ` ${nameOf(c.agentId)} · ${when(c.lastMessageAt ?? c.openedAt)}`,
          ),
        ),
      ),
    );
    const side = el(
      'div',
      { className: 'kindgi-side' },
      el('label', { for: 'kindgi-agent' }, __('Agent', 'kindgi')),
      agents.agents.length === 0
        ? el(
            'p',
            { className: 'kindgi-muted' },
            __('No agent in this project you can ask.', 'kindgi'),
          )
        : picker,
      startButton,
      el('h2', {}, __('Your conversations', 'kindgi')),
      conversations.conversations.length === 0
        ? el('p', { className: 'kindgi-muted' }, __('None yet.', 'kindgi'))
        : list,
    );
    const main = el('div', { className: 'kindgi-main' });
    panel.replaceChildren(el('div', { className: 'kindgi-columns' }, side, main));
    if (state.conversationId !== null || state.newAgent !== null) renderConversation(main);
  }

  /** The first line of a message, as a conversation's title. */
  const titleOf = (text) => {
    const line = text.split('\n', 1)[0];
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  };

  /** The open conversation, or a new one's empty page until its first message. */
  async function renderConversation(main) {
    main.replaceChildren(el('p', { className: 'kindgi-muted' }, __('Loading…', 'kindgi')));
    let messages = { messages: [] };
    if (state.conversationId !== null) {
      try {
        messages = await api(`/conversations/${encodeURIComponent(state.conversationId)}/messages`);
      } catch (error) {
        main.replaceChildren(notice(error));
        return;
      }
    }
    const log = el(
      'ol',
      { className: 'kindgi-messages', 'aria-live': 'polite' },
      messages.messages.map(message).filter((item) => item !== null),
    );
    const progress = el('div', { className: 'kindgi-progress', 'aria-live': 'polite' });
    const input = el('textarea', { id: 'kindgi-message', rows: '3', maxlength: '20000' });
    const send = el(
      'button',
      {
        type: 'button',
        className: 'button button-primary',
        onclick: async () => {
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
            }
            const turn = await api(
              `/conversations/${encodeURIComponent(state.conversationId)}/turns`,
              { method: 'POST', data: { message: text } },
            );
            await follow(turn.runId, progress);
          } catch (error) {
            progress.replaceChildren(notice(error));
            send.disabled = false;
            return;
          }
          renderAsk();
        },
      },
      __('Send', 'kindgi'),
    );
    main.replaceChildren(
      state.conversationId === null
        ? el(
            'p',
            { className: 'kindgi-muted' },
            sprintf(
              __('A new conversation with %s.', 'kindgi'),
              state.newAgent.name || state.newAgent.id,
            ),
          )
        : null,
      log,
      progress,
      el(
        'label',
        { for: 'kindgi-message', className: 'screen-reader-text' },
        __('Your message', 'kindgi'),
      ),
      input,
      send,
    );
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
          el(
            'summary',
            {},
            sprintf(__('%s answered', 'kindgi'), m.toolId ?? __('A tool', 'kindgi')),
          ),
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
            sprintf(__('Calls %s', 'kindgi'), m.calls.join(', ')),
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

  /** Follows a turn until it ends: its steps, and what it waits for. */
  async function follow(runId, progress) {
    let since = 0;
    const steps = el('ul', { className: 'kindgi-steps' });
    const waits = el('div');
    progress.replaceChildren(steps, waits);
    for (;;) {
      const run = await api(`/runs/${encodeURIComponent(runId)}?since=${since}`);
      since = run.since;
      const tools = run.steps.filter((step) => step.toolId !== null);
      steps.append(
        ...tools.map((step) => el('li', {}, sprintf(__('Tool: %s', 'kindgi'), step.toolId))),
      );
      waits.replaceChildren(...run.waitingFor.map(waitFor));
      if (ENDED.includes(run.status)) {
        if (run.status === 'failed') progress.append(notice({ message: run.failureMessage }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** A wait in a turn: for a reviewer, the approval's card; for anyone else, who it waits for. */
  function waitFor(wait) {
    const box = el(
      'div',
      { className: 'kindgi-wait' },
      el(
        'p',
        {},
        sprintf(__('Waiting for a person to approve %s.', 'kindgi'), wait.toolId ?? wait.title),
      ),
    );
    if (state.me.reviewerRole !== null) {
      // The turn's own polling shows what happens after a decision.
      api(`/approvals/${encodeURIComponent(wait.approvalId)}`)
        .then((card) => box.replaceChildren(approvalCard(card)))
        .catch((error) => box.append(notice(error)));
    }
    return box;
  }

  // ---------- Approvals ----------

  async function renderApprovals() {
    const panel = panels.approvals;
    panel.replaceChildren(el('p', { className: 'kindgi-muted' }, __('Loading…', 'kindgi')));
    let waiting;
    let decided;
    try {
      [waiting, decided] = await Promise.all([
        api('/approvals?view=waiting'),
        api('/approvals?view=decided'),
      ]);
    } catch (error) {
      panel.replaceChildren(notice(error));
      return;
    }
    const reload = () => renderApprovals();
    const opened = config.approval ?? null;
    config.approval = null;
    const parts = [];
    if (opened !== null && !waiting.approvals.some((a) => a.id === opened)) {
      // A link from an email: this one approval, whatever its state.
      try {
        parts.push(
          el('h2', {}, __('From your link', 'kindgi')),
          approvalCard(await api(`/approvals/${encodeURIComponent(opened)}`), reload),
        );
      } catch (error) {
        parts.push(notice(error));
      }
    }
    parts.push(
      el('h2', {}, __('Waiting for you', 'kindgi')),
      waiting.approvals.length === 0
        ? el('p', { className: 'kindgi-muted' }, __('Nothing waits for you.', 'kindgi'))
        : el(
            'div',
            { className: 'kindgi-cards' },
            waiting.approvals.map((a) => approvalCard(a, reload)),
          ),
      el('h2', {}, __('Decided by you lately', 'kindgi')),
      decided.approvals.length === 0
        ? el('p', { className: 'kindgi-muted' }, __('None yet.', 'kindgi'))
        : el(
            'div',
            { className: 'kindgi-cards' },
            decided.approvals.map((a) => approvalCard(a, reload)),
          ),
    );
    panel.replaceChildren(...parts);
    const target =
      opened === null ? null : panel.querySelector(`[data-approval="${CSS.escape(opened)}"]`);
    target?.scrollIntoView({ block: 'center' });
  }

  const who = (name) => name ?? __('someone outside this site', 'kindgi');

  /** A tool call's arguments: a list of its fields, and the raw JSON a click away. */
  function argumentsOf(args) {
    if (args === undefined || args === null) return [];
    const rows =
      typeof args === 'object' && !Array.isArray(args)
        ? Object.entries(args).map(([key, value]) => [
            el('dt', {}, key),
            el('dd', {}, typeof value === 'string' ? value : JSON.stringify(value)),
          ])
        : [];
    return [
      rows.length > 0 ? el('dl', { className: 'kindgi-args' }, rows) : null,
      el(
        'details',
        {},
        el('summary', {}, __('Raw arguments', 'kindgi')),
        el('pre', {}, JSON.stringify(args, null, 2)),
      ),
    ];
  }

  /** Who asked (when Kindgi recorded it) and when, the agent, the expiry, and the role it needs. */
  function aboutCard(card) {
    let asked = sprintf(__('Asked %s', 'kindgi'), when(card.createdAt));
    if (card.askedByMe) asked = sprintf(__('Asked by you, %s', 'kindgi'), when(card.createdAt));
    else if (card.askedByKnown) {
      asked = sprintf(__('Asked by %1$s, %2$s', 'kindgi'), who(card.askedBy), when(card.createdAt));
    }
    return el(
      'p',
      { className: 'kindgi-muted' },
      asked,
      card.agentId ? ` · ${sprintf(__('agent %s', 'kindgi'), card.agentId)}` : '',
      card.expiresAt ? ` · ${sprintf(__('expires %s', 'kindgi'), when(card.expiresAt))}` : '',
      ` · ${sprintf(__('needs a %s reviewer', 'kindgi'), card.requiredRole)}`,
    );
  }

  function conversationLink(card) {
    if (!card.conversationId) return null;
    return el(
      'button',
      {
        type: 'button',
        className: 'button-link',
        onclick: () => {
          state.conversationId = card.conversationId;
          state.newAgent = null;
          showTab('ask');
        },
      },
      __('Open the conversation', 'kindgi'),
    );
  }

  /** What a card ends with: the decision made, why none can be, or the controls to make one. */
  function cardEnding(card, after) {
    if (card.decision !== null) return decisionLine(card.decision);
    if (card.status !== 'pending') {
      return el('p', {}, sprintf(__('This approval is %s.', 'kindgi'), card.status));
    }
    if (card.askedByMe && card.separateApprover) {
      return el(
        'p',
        { className: 'kindgi-note' },
        __('You asked for this; another reviewer decides.', 'kindgi'),
      );
    }
    return decisionControls(card, after);
  }

  /** One approval: what the tool would do, who asked, and the decision. */
  function approvalCard(card, after) {
    return el(
      'div',
      { className: 'kindgi-card', 'data-approval': card.id },
      el('h3', {}, card.tool !== null ? card.tool.id : card.title),
      card.description ? el('p', {}, card.description) : null,
      argumentsOf(card.tool?.arguments),
      aboutCard(card),
      conversationLink(card),
      cardEnding(card, after),
    );
  }

  /** What a decision did, once Kindgi recorded it. */
  function decided(done) {
    const line =
      done.approval.decision !== null ? decisionLine(done.approval.decision) : el('p', {}, '');
    if (done.waitpointResolved) return [line];
    return [
      line,
      el(
        'p',
        { className: 'kindgi-muted' },
        sprintf(__('The turn had already moved on (%s).', 'kindgi'), done.runStatus ?? ''),
      ),
    ];
  }

  /** Approve, or reject with a reason. */
  function decisionControls(card, after) {
    const reason = el('textarea', {
      rows: '2',
      maxlength: '2000',
      'aria-label': __('Reason', 'kindgi'),
    });
    const result = el('div', { 'aria-live': 'polite' });
    const buttons = el('p');
    const setDisabled = (disabled) => {
      for (const b of buttons.querySelectorAll('button')) b.disabled = disabled;
    };
    const decide = async (decision) => {
      if (decision === 'reject' && reason.value.trim() === '') {
        result.replaceChildren(notice({ message: __('Say why you reject it.', 'kindgi') }));
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

  function decisionLine(decision) {
    const text =
      decision.decision === 'approve' || decision.decision === 'approved'
        ? sprintf(
            __('Approved by %1$s, %2$s', 'kindgi'),
            who(decision.by),
            when(decision.decidedAt),
          )
        : sprintf(
            __('Rejected by %1$s, %2$s', 'kindgi'),
            who(decision.by),
            when(decision.decidedAt),
          );
    return el(
      'p',
      { className: 'kindgi-decision' },
      text,
      decision.reason ? `: ${decision.reason}` : '',
    );
  }

  start();
})();
