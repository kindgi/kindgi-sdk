// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Kindgi → Settings: what only Kindgi knows, asked once the page is drawn,
 * so Settings (and connecting again) never waits on Kindgi. The project's
 * name joins the connection line, and the project's agents fill the form
 * that offers them to staff. Everything is set as text.
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

  /** The connection line, with the project's name once Kindgi tells it; without, it stays as drawn. */
  async function projectName() {
    const line = document.getElementById('kindgi-connected');
    if (line === null) return;
    let project;
    try {
      project = await api('/project');
    } catch {
      return;
    }
    if (!project.name) return;
    line.replaceChildren(
      ...withNodes(
        /* translators: 1: Kindgi's public URL, 2: the project's name */
        __(
          'Connected to Kindgi at %1$s, for the project %2$s. Your staff sign in to it as themselves from the Kindgi pages.',
          'kindgi',
        ),
        el('code', {}, line.dataset.audience),
        el('strong', {}, project.name),
      ),
    );
  }

  /** One agent's box: ticked when offered, with what it's for. */
  const agentBox = (agent) =>
    el(
      'p',
      {},
      el('input', { type: 'hidden', name: 'kindgi_shown[]', value: agent.id }),
      el(
        'label',
        {},
        el('input', {
          type: 'checkbox',
          name: 'kindgi_agents[]',
          value: agent.id,
          checked: agent.offered,
        }),
        ' ',
        el('strong', {}, agent.name || agent.id),
      ),
      agent.description
        ? [el('br'), el('span', { className: 'description' }, agent.description)]
        : null,
    );

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
          {},
          __('The project has no agents yet. Once one is deployed, it shows here.', 'kindgi'),
        ),
      );
      return;
    }
    list.replaceChildren(...answer.agents.map(agentBox));
    const save = form.querySelector('[type="submit"]');
    if (save !== null) save.disabled = false;
  }

  projectName();
  agents();
})();
