// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Kindgi → Settings: what only Kindgi knows, asked once the page is drawn,
 * so Settings (and connecting again) never waits on Kindgi. Signing in is
 * checked, the project's name joins the connection's row, and the
 * project's agents fill the form that offers them to staff. Before the
 * site is connected, the addresses Kindgi registers get a Copy button.
 * Everything is set as text.
 */
(() => {
  const { __ } = wp.i18n;
  const api = (path) => wp.apiFetch({ path: `/kindgi/v1${path}` });

  const absent = (value) => value === undefined || value === null || value === false;

  /** One attribute: `className` the class, `true` a bare attribute. */
  function setAttribute(node, key, value) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }

  /** An element with attributes and children; strings become text nodes. */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (!absent(value)) setAttribute(node, key, value);
    }
    for (const child of children.flat()) {
      if (absent(child)) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** A translated sentence with nodes in its `%1$s`, `%2$s` places. */
  const withNodes = (format, ...nodes) =>
    format.split(/(%\d\$s)/).map((part) => {
      const at = /^%(\d)\$s$/.exec(part);
      return at === null ? part : nodes[Number(at[1]) - 1];
    });

  /** A row of the connection at a glance, set to a state: the dot, its title's words, and the rest. */
  function setRow(row, state, title, ...text) {
    row.className = `kindgi-status-row kindgi-status-${state}`;
    row.querySelector('.kindgi-status-title').textContent = title;
    row.querySelector('.kindgi-status-text').replaceChildren(...text);
  }

  /**
   * Signing in, checked: asking for the project signs this administrator
   * in as themselves, as it does any of the staff. The connection's row
   * gains the project's name; without one, it stays as drawn.
   */
  async function connection() {
    const connected = document.getElementById('kindgi-connected');
    const signin = document.getElementById('kindgi-signin');
    if (connected === null) return;
    let project;
    try {
      project = await api('/project');
    } catch (error) {
      if (signin !== null) {
        setRow(
          signin,
          'err',
          __("Kindgi didn't sign you in", 'kindgi'),
          error?.message ?? __('Something went wrong.', 'kindgi'),
        );
      }
      return;
    }
    if (signin !== null) {
      setRow(
        signin,
        'ok',
        __('Staff sign in as themselves', 'kindgi'),
        __('Kindgi signed you in just now.', 'kindgi'),
      );
    }
    if (!project.name) return;
    setRow(
      connected,
      'ok',
      __('Connected', 'kindgi'),
      ...withNodes(
        /* translators: 1: the project's name, 2: Kindgi's public URL */
        __('To the project %1$s, at %2$s.', 'kindgi'),
        el('strong', {}, project.name),
        el('code', {}, connected.dataset.audience),
      ),
    );
  }

  /** One agent's row: ticked when offered, with what it's for; the whole row ticks it. */
  function agentRow(agent) {
    const id = `kindgi-offer-${agent.id}`;
    return el(
      'div',
      { className: 'kindgi-offer-row' },
      el('input', { type: 'hidden', name: 'kindgi_shown[]', value: agent.id }),
      el('input', {
        type: 'checkbox',
        id,
        name: 'kindgi_agents[]',
        value: agent.id,
        checked: agent.offered,
      }),
      el(
        'label',
        { for: id },
        el('strong', {}, agent.name || agent.id),
        agent.description ? el('span', { className: 'description' }, agent.description) : null,
      ),
    );
  }

  /** The offer form's agents, from Kindgi; Save works once they're there. */
  async function agents() {
    const form = document.getElementById('kindgi-offer');
    const list = form?.querySelector('.kindgi-offer-list');
    if (!list) return;
    let answer;
    try {
      answer = await api('/agents');
    } catch (error) {
      const message = error?.message ?? __('Something went wrong.', 'kindgi');
      list.replaceChildren(
        el('div', { className: 'notice notice-error inline' }, el('p', {}, message)),
      );
      return;
    }
    if (answer.agents.length === 0) {
      list.replaceChildren(
        el(
          'p',
          { className: 'kindgi-offer-none' },
          __('The project has no agents yet. Once one is deployed, it shows here.', 'kindgi'),
        ),
      );
      return;
    }
    list.replaceChildren(...answer.agents.map(agentRow));
    const save = form.querySelector('[type="submit"]');
    if (save !== null) save.disabled = false;
  }

  /** A Copy button after each address Kindgi registers, where the browser lets a page copy. */
  function copyButtons() {
    if (typeof navigator.clipboard?.writeText !== 'function') return;
    for (const code of document.querySelectorAll('[data-kindgi-copy]')) {
      const button = el(
        'button',
        { type: 'button', className: 'button button-small kindgi-copy' },
        __('Copy', 'kindgi'),
      );
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.textContent);
          button.textContent = __('Copied', 'kindgi');
        } catch {
          button.textContent = __("Couldn't copy", 'kindgi');
        }
        setTimeout(() => {
          button.textContent = __('Copy', 'kindgi');
        }, 2000);
      });
      code.after(' ', button);
    }
  }

  connection();
  agents();
  copyButtons();
})();
