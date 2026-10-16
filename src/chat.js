// The session's chat panel. Messages travel on the room's own socket (message
// type MSG_CHAT, see server/rooms.js), so everyone in the session is in the
// chat, and the server writes who sent each message from their account.

import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { el, face, clock, toast, notify } from './ui.js';

export const MSG_CHAT = 100;
const GROUP_MS = 5 * 60_000; // messages this close together from one person share a header
const TYPING_MS = 4000;

export class Chat {
  /**
   * @param {{ panel: HTMLElement, log: HTMLElement, form: HTMLFormElement, input: HTMLTextAreaElement, typing: HTMLElement, badge: HTMLElement }} els
   * @param {import('y-websocket').WebsocketProvider} provider
   * @param {{ me: () => object, openProfile: (user: object, anchor: HTMLElement) => void, onToggle?: (open: boolean) => void }} hooks
   */
  constructor(els, provider, hooks) {
    this.els = els;
    this.provider = provider;
    this.hooks = hooks;
    this.messages = []; // from the server's history plus everything since
    this.notices = []; // "joined" / "left", live only
    this.unread = 0;
    this.isOpen = false;
    this.lastTyping = 0;

    provider.messageHandlers[MSG_CHAT] = (encoder, decoder) => {
      let msg;
      try {
        msg = JSON.parse(decoding.readVarString(decoder));
      } catch {
        return;
      }
      this.receive(msg);
    };
    const hello = () => this.send({ type: 'hello' });
    provider.on('status', ({ status }) => status === 'connected' && hello());
    if (provider.wsconnected) hello();

    els.form.onsubmit = (e) => {
      e.preventDefault();
      this.say();
    };
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.say();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    els.input.addEventListener('input', () => {
      this.grow();
      const now = Date.now();
      if (els.input.value && now - this.lastTyping > 1500) {
        this.lastTyping = now;
        provider.awareness.setLocalStateField('typing', now);
      }
    });
    els.input.addEventListener('blur', () => this.stopTyping());
    setInterval(() => this.isOpen && this.drawTyping(), 1000);
  }

  send(msg) {
    const ws = this.provider.ws;
    if (!this.provider.wsconnected || ws?.readyState !== 1) return false;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_CHAT);
    encoding.writeVarString(e, JSON.stringify(msg));
    ws.send(encoding.toUint8Array(e));
    return true;
  }

  say() {
    const text = this.els.input.value.trim();
    if (!text) return;
    if (!this.send({ type: 'say', text })) return toast('You’re offline. Your message will be here to send when you reconnect.');
    this.els.input.value = '';
    this.grow();
    this.stopTyping();
  }

  stopTyping() {
    if (!this.lastTyping) return;
    this.lastTyping = 0;
    this.provider.awareness.setLocalStateField('typing', null);
  }

  receive(msg) {
    const me = this.hooks.me();
    if (msg.type === 'history') {
      this.messages = msg.messages;
      this.notices = [];
    } else if (msg.type === 'message') {
      if (this.messages.some((m) => m.id === msg.message.id)) return;
      this.messages.push(msg.message);
      const mine = msg.message.user.id === me.id;
      if (!mine && !this.isOpen) {
        this.unread++;
        if (mentions(msg.message.text, me.username)) {
          const u = msg.message.user;
          notify({ user: u, text: `${u.name}: ${msg.message.text.slice(0, 140)}`, actions: [{ label: 'Reply', primary: true, run: () => this.open() }], timeout: 10_000 });
        }
      }
    } else if (msg.type === 'notice') {
      if (msg.notice.user.id === me.id) return;
      this.notices.push(msg.notice);
    } else if (msg.type === 'error') {
      return toast(msg.error);
    }
    this.draw();
  }

  open() {
    this.isOpen = true;
    this.unread = 0;
    this.els.panel.hidden = false;
    this.draw();
    this.els.input.focus();
    this.hooks.onToggle?.(true);
  }

  close() {
    this.isOpen = false;
    this.els.panel.hidden = true;
    this.stopTyping();
    this.drawBadge();
    this.hooks.onToggle?.(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Start a message to someone: "@ana ". */
  mention(username) {
    this.open();
    const input = this.els.input;
    const tag = `@${username} `;
    if (!input.value.includes(tag)) input.value = `${input.value.trim() ? `${input.value.trimEnd()} ` : ''}${tag}`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this.grow();
  }

  grow() {
    const input = this.els.input;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  drawBadge() {
    const b = this.els.badge;
    b.hidden = !this.unread;
    b.textContent = this.unread > 99 ? '99+' : String(this.unread);
  }

  draw() {
    this.drawBadge();
    if (!this.isOpen) return;
    const me = this.hooks.me();
    const items = [...this.messages.map((m) => ({ ...m, kind: 'message' })), ...this.notices].sort((a, b) => a.at - b.at);
    const log = this.els.log;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const out = [];
    let prev = null;
    for (const m of items) {
      if (m.kind !== 'message') {
        out.push(el('p', { class: 'chat-notice' }, `${m.user.name} ${m.kind === 'join' ? 'joined' : 'left'} · ${clock(m.at)}`));
        prev = null;
        continue;
      }
      const grouped = prev && prev.user.id === m.user.id && m.at - prev.at < GROUP_MS;
      const mine = m.user.id === me.id;
      out.push(
        el(
          'div',
          { class: `chat-msg${grouped ? ' grouped' : ''}${mine ? ' mine' : ''}${!mine && mentions(m.text, me.username) ? ' mentions-me' : ''}` },
          grouped
            ? null
            : el(
                'div',
                { class: 'chat-head' },
                el('button', { type: 'button', class: 'chat-who', style: `--c:${m.user.color}`, onclick: (e) => this.hooks.openProfile(m.user, e.currentTarget) }, face(m.user, { size: 22 }), el('b', {}, m.user.name)),
                m.user.guest ? el('span', { class: 'pill' }, 'guest') : null,
                el('time', { class: 'hint', datetime: new Date(m.at).toISOString() }, clock(m.at)),
              ),
          el('p', { class: 'chat-text' }, ...formatText(m.text, me.username)),
        ),
      );
      prev = m;
    }
    if (!out.length) out.push(el('p', { class: 'hint chat-empty' }, 'No messages yet. Say hi, share an idea, or @mention someone.'));
    log.replaceChildren(...out);
    if (atBottom || items.at(-1)?.user?.id === me.id) log.scrollTop = log.scrollHeight;
    this.drawTyping();
  }

  drawTyping() {
    const now = Date.now();
    const me = this.hooks.me();
    const typing = [];
    for (const [id, s] of this.provider.awareness.getStates()) {
      if (id !== this.provider.doc.clientID && s.user && s.user.id !== me.id && s.typing && now - s.typing < TYPING_MS && !typing.includes(s.user.name)) typing.push(s.user.name);
    }
    this.els.typing.textContent = !typing.length ? '' : typing.length === 1 ? `${typing[0]} is typing…` : `${typing.slice(0, 2).join(' and ')} are typing…`;
  }
}

const mentions = (text, username) => !!username && new RegExp(`(^|[^\\w@])@${username}(?![\\w])`, 'i').test(text);

/** Text with @mentions and links marked up, as DOM nodes (never HTML, so messages can't inject anything). */
function formatText(text, username) {
  const out = [];
  const re = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])|(^|[^\w@])@([a-z0-9_]{3,20})\b/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      out.push(text.slice(last, m.index), el('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer' }, m[1]));
      last = m.index + m[1].length;
    } else {
      const start = m.index + m[2].length;
      out.push(text.slice(last, start), el('span', { class: `mention${m[3].toLowerCase() === username ? ' me' : ''}` }, `@${m[3]}`));
      last = start + 1 + m[3].length;
    }
  }
  out.push(text.slice(last));
  return out.filter(Boolean);
}
