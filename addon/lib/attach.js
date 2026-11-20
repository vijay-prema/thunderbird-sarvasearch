'use strict';
// Opening one attachment of a search result. Exposes globalThis.SarvaAttach.
//
// The indexed payload carries attachment NAMES only — that is what the card
// shows, and names are deliberately kept out of the embedded text so a rename
// does not re-embed the mailbox. Opening one therefore needs the live list from
// Thunderbird to get the MIME part name openAttachment() takes.
//
// The message is resolved the usual way, by RFC Message-ID (see ingest/open.js
// for why a stored numeric id is never trusted), so a click on an attachment
// opens it even after a restart or a move to another folder.
(function () {
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

  // The stored name -> the live attachment. Position first: the add-on mirrors
  // Thunderbird's own attachment classification, so entry i of the payload is
  // entry i of listAttachments() — and for two attachments called "scan.pdf"
  // that is the only thing that tells them apart. The name is the fallback, for
  // mail whose attachments changed after it was indexed.
  function pick(list, name, index) {
    const items = Array.isArray(list) ? list.filter((a) => a && a.partName) : [];
    if (!items.length) return null;
    if (Number.isInteger(index) && index >= 0 && index < items.length) {
      if (norm(items[index].name) === norm(name)) return items[index];
    }
    return items.find((a) => norm(a.name) === norm(name)) || null;
  }

  // openAttachment() needs a tab: it opens the attachment in (for PDFs) or from
  // (for everything else, via the OS handler) that tab's window. The page this
  // runs in is a tab, so use it; a mail tab is the fallback for a page that is
  // not in one.
  async function tabIdFor() {
    try {
      const tab = await messenger.tabs.getCurrent();
      if (tab && tab.id != null) return tab.id;
    } catch (e) {
      /* not running in a tab */
    }
    try {
      const [tab] = await messenger.mailTabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) return tab.id;
    } catch (e) {
      /* no mail tab to borrow */
    }
    return null;
  }

  // -> {ok: true, name} | {ok: false, reason: 'message-not-found' |
  //    'list-failed' | 'attachment-missing' | 'open-failed', error?}
  async function open(msg, { name = '', index } = {}) {
    const id = await SarvaOpen.resolveMessageId(msg);
    if (id == null) return { ok: false, reason: 'message-not-found' };

    let list = [];
    try {
      list = (await messenger.messages.listAttachments(id)) || [];
    } catch (e) {
      return { ok: false, reason: 'list-failed', error: e.message };
    }

    const attachment = pick(list, name, index);
    if (!attachment) return { ok: false, reason: 'attachment-missing' };

    try {
      await messenger.messages.openAttachment(id, attachment.partName, await tabIdFor());
      return { ok: true, name: attachment.name || name };
    } catch (e) {
      return { ok: false, reason: 'open-failed', error: e.message };
    }
  }

  globalThis.SarvaAttach = { pick, open, tabIdFor };
})();
