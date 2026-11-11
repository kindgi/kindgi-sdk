// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The texts tools built into Kindgi, and the text thread a run a text
 * started answers. The tools are offered in such a run only, never listed
 * in an agent's `tools`; the number, channel and sender come from the run,
 * never from the model.
 */

/** Answers the person who texted, on the run's thread. */
export const REPLY_TO_TEXT_TOOL_ID = 'kindgi_reply_to_text';

/**
 * Hands the run's thread to a person: its trigger starts no runs for it
 * from then on. In a run a text started it never waits for a person's yes
 * because no person is watching (`unattendedWaitReason`); the workspace's
 * floor and the agent's own rules still apply.
 */
export const HAND_TO_PERSON_TOOL_ID = 'kindgi_hand_to_person';

/**
 * Starts a conversation from a number. Not offered yet; its id is fixed
 * so a trigger's `toolsAllowedUnattended` can refuse it: a text that isn't
 * a reply always waits for a person's yes.
 */
export const SEND_TEXT_TOOL_ID = 'kindgi_send_text';

/** What a texts connection's registration grants: `texts.reply`, `texts.send`. */
export type TextGrant = 'texts.reply' | 'texts.send';

/**
 * The thread a text trigger's run answers: the connection and number the
 * text came to, its channel, who sent it, and the thread it belongs to.
 * Set by the runtime when the trigger fires, on the trigger's target only:
 * the triggered run, and the runs of its flow's agent steps. A run an
 * agent's tool or another step starts never inherits it. Kept with the
 * run, so a turn resumed after a wait answers the same thread.
 */
export interface RunTextThread {
  /** The texts connection the number belongs to. */
  readonly connectionId: string;
  /** The number the text came to, in E.164. */
  readonly number: string;
  readonly channel: 'sms' | 'whatsapp';
  /** Who texted, in E.164. */
  readonly sender: string;
  readonly threadId: string;
  /**
   * What the number's registration grants, as the runtime read it when
   * the trigger fired. The reply tool is offered only with `texts.reply`;
   * the runtime checks again at each call.
   */
  readonly grants: readonly TextGrant[];
}
