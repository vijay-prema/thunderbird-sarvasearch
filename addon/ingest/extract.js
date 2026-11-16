'use strict';
// Pure, messenger-free text extraction. Turns a MIME tree (from
// messenger.messages.getFull) into an index doc. Shared by the main-thread
// indexer (incremental updates) and the extractor worker pool (bulk rebuild),
// so the CPU-heavy HTML stripping can run off the main thread and across cores.
//
// Ported verbatim from CR0CKER/thunderbird-omnisearch (MIT) — its lib/extract.js.
// Exposes globalThis.OmniExtract — works both as a background script and via
// importScripts() inside a worker.
(function () {
  const PREVIEW_LEN = 200;
  // Default cap on indexed body length (chars). Bounds the index size / memory /
  // cold-load time; the caller can override per-message (the configurable
  // "Indexed body length" setting, threaded through buildDoc). Smaller = smaller
  // resident index = faster, more consistent cold loads on low-RAM machines.
  const DEFAULT_MAX_BODY = 4000;
  // Hard ceiling on how much raw body text the HTML/quote stripping regexes ever
  // see, regardless of the (much smaller) indexed-body cap. Message bodies are
  // attacker-controlled, and a few of the strip patterns (the greedy <blockquote>
  // match, the line-wise quote scan) can do near-quadratic work on a pathological
  // body — a huge message, many unclosed <blockquote> tags, or one enormous line.
  // Bounding the input keeps that worst case linear-ish. 100k is ~5x the largest
  // selectable body length, and the indexed "new" text is normally at the top
  // (top-posting), so this never costs real content. Belt-and-suspenders: stripping
  // runs in the extractor worker pool, so even an unbounded stall couldn't freeze
  // the UI — this just stops it wasting a core.
  const MAX_EXTRACT_INPUT = 100000;

  function stripHtml(html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      // Drop quoted reply content: Gmail/Apple Mail wrap the quoted message in
      // <blockquote>. The match is greedy (first open → last close) so nested
      // quote levels in a deep thread all go in one shot. (Outlook quotes a
      // border <div> instead of a blockquote; that's caught downstream by
      // stripQuoted via the header block, since we keep newlines below.)
      .replace(/<blockquote[\s\S]*<\/blockquote>/gi, ' ')
      // Turn block-level boundaries into newlines BEFORE dropping tags, so the
      // line-based stripQuoted pass (run on this output in extractText) can see
      // Outlook's "From:/Sent:/…" header block on its own lines.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#\d+;/g, ' ')
      // Collapse runs of spaces/tabs but preserve newlines (and cap blank runs).
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function collectParts(part, plain, html) {
    if (!part) return;
    const ct = (part.contentType || '').toLowerCase();
    if (typeof part.body === 'string' && part.body.length) {
      if (ct.startsWith('text/plain')) plain.push(part.body);
      else if (ct.startsWith('text/html')) html.push(part.body);
    }
    for (const child of part.parts || []) collectParts(child, plain, html);
  }

  function cap(text, maxBody) {
    const limit = maxBody > 0 ? maxBody : DEFAULT_MAX_BODY;
    return text.length > limit ? text.slice(0, limit) : text;
  }

  // True if a (non-decrypted) MIME tree is an OpenPGP/S-MIME encrypted message,
  // or carries an inline-PGP armored block. Signed-but-not-encrypted mail is NOT
  // treated as encrypted (its content is plaintext).
  function isEncrypted(part) {
    if (!part) return false;
    const ct = (part.contentType || '').toLowerCase();
    if (ct.indexOf('multipart/encrypted') !== -1) return true; // PGP/MIME
    if (ct.indexOf('application/pgp-encrypted') !== -1) return true;
    if (ct.indexOf('pkcs7-mime') !== -1) return true; // S/MIME (application/[x-]pkcs7-mime)
    if (
      ct.startsWith('text/') &&
      typeof part.body === 'string' &&
      part.body.indexOf('-----BEGIN PGP MESSAGE-----') !== -1
    ) {
      return true;
    }
    for (const child of part.parts || []) if (isEncrypted(child)) return true;
    return false;
  }

  // Remove quoted reply text from a plain-text body so a long thread doesn't
  // index the same content once per message. Drops '>'-quoted lines and truncates
  // at common attribution / "Original Message" markers (top-posting is the norm:
  // new text on top, quote below). If stripping would leave nothing (a quote-only
  // message, e.g. a bare forward), keep the original so we still index it.
  // Attribution opener ("On … wrote:") and its terminators, in several languages.
  // Tested against the current line joined with the next ~2, so the match still
  // fires when the client wrapped a long attribution across lines.
  const ATTR_OPENER = /^\s*(On|Am|Le|El)\b/i;
  const ATTR_TERMINATOR = /\b(wrote:|schrieb.*:|a écrit\s*:|escribió:)\s*$/i;
  // Outlook quote header block: a "From:" line followed shortly by a "Sent:"/
  // "Date:" line (localised). Requiring the pair keeps false-positives low.
  const OUTLOOK_FROM = /^\s*(From|Von|De)\s*:/i;
  const OUTLOOK_SENT = /^\s*(Sent|Date|Gesendet|Envoyé)\s*:/i;
  // "Forwarded message" banner, in two shapes: dash-delimited (Thunderbird, e.g.
  // "-------- Forwarded Message --------") and the Apple-Mail "Begin forwarded
  // message:" header — both localised (EN/DE/FR/ES).
  const FWD_DASHED = /^\s*-{2,}\s*(original message|forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado)\s*-{2,}/i;
  const FWD_BEGIN = /^\s*(begin forwarded message|anfang der weitergeleiteten nachricht|début du message transféré|inicio del mensaje reenviado)\s*:/i;

  function stripQuoted(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*>/.test(line)) continue; // quoted line
      if (FWD_DASHED.test(line) || FWD_BEGIN.test(line)) break;
      // Attribution line ("On … wrote:"), possibly wrapped onto the next 1-2
      // lines — join and test the combined string against the terminators.
      if (ATTR_OPENER.test(line)) {
        const joined = lines.slice(i, i + 3).join(' ');
        if (ATTR_TERMINATOR.test(line) || ATTR_TERMINATOR.test(joined)) break;
      }
      // Outlook header block: "From:" now, "Sent:"/"Date:" within the next 3.
      if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_SENT.test(l))) break;
      out.push(line);
    }
    const stripped = out.join('\n').trim();
    return stripped || text.trim();
  }

  // Bound the input to the (potentially quadratic) strip passes — see
  // MAX_EXTRACT_INPUT. Slicing by UTF-16 code unit can leave a lone high surrogate
  // at the cut; drop it so the text stays valid (same guard as previewOf).
  function capInput(s) {
    if (s.length <= MAX_EXTRACT_INPUT) return s;
    let p = s.slice(0, MAX_EXTRACT_INPUT);
    const last = p.charCodeAt(p.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) p = p.slice(0, -1);
    return p;
  }

  function extractText(full) {
    const plain = [];
    const html = [];
    collectParts(full, plain, html);
    let text = plain.join('\n').trim();
    if (text) return stripQuoted(capInput(text));
    // HTML-only body: <blockquote> quotes are dropped in stripHtml; run the same
    // line-based pass on the result to catch Outlook's header-block quotes (which
    // aren't blockquotes), since stripHtml now preserves block newlines.
    if (html.length) return stripQuoted(stripHtml(capInput(html.join('\n'))));
    return '';
  }

  // First PREVIEW_LEN chars of the body, without splitting a surrogate pair at
  // the cut (slicing by UTF-16 code unit can leave a lone high surrogate, which
  // renders as a broken character). Drop a dangling high surrogate.
  function previewOf(text) {
    let p = text.slice(0, PREVIEW_LEN);
    const last = p.charCodeAt(p.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) p = p.slice(0, -1);
    return p;
  }

  // Lone UTF-16 surrogates (half of an emoji) are not encodable as UTF-8, so
  // the Qdrant payload's JSON write raises on them — a single such message
  // failed a whole rebuild. Two sources: cutting
  // a body at the length cap between a high and a low surrogate, and MIME
  // decoding handing back an already-broken string. Replace the unpaired halves
  // with U+FFFD (properly paired ones are left alone).
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

  function clean(text) {
    return typeof text === 'string' ? text.replace(LONE_SURROGATE, '\uFFFD') : text;
  }

  // ---- Attachments ----
  // File names of the parts a message carries, for the result cards. Only the
  // names are stored (never the content) and the UI shows the first few.
  //
  // Detection mirrors Thunderbird's own attachment pane (WebExtMimeTreeEmitter
  // in ExtensionMessages.sys.mjs) so the list matches what the user sees when
  // they open the message: multipart parts are never attachments, text/* only
  // when Content-Disposition says `attachment`, non-text parts when they have a
  // filename; an attached message is always one. MessagePart.name already holds
  // the disposition filename (else the Content-Type name), but it is only
  // populated when getFull's decodeHeaders ran, so the headers are parsed as a
  // fallback.
  const MAX_ATTACHMENT_NAMES = 20;
  // Parts Thunderbird never lists as attachments (signatures, or the PGP/MIME
  // envelope of an encrypted message).
  const NOT_ATTACHMENT_TYPES = new Set([
    'application/pgp-signature',
    'application/pkcs7-signature',
    'application/x-pkcs7-signature',
    'application/pgp-encrypted',
    'application/pkcs7-mime',
    'application/x-pkcs7-mime',
  ]);

  function headerFirst(part, name) {
    const headers = part && part.headers;
    if (!headers) return '';
    const v = headers[name];
    if (Array.isArray(v)) return v[0] || '';
    return typeof v === 'string' ? v : '';
  }

  // A MIME parameter (filename / name), including RFC 2231's
  // `filename*=UTF-8''report%20final.pdf` spelling.
  function paramOf(header, param) {
    if (!header) return '';
    const ext = new RegExp(`(?:^|;)\\s*${param}\\*\\s*=\\s*([^;]+)`, 'i').exec(header);
    if (ext) {
      let v = ext[1].trim().replace(/^["']|["']$/g, '');
      const q = v.indexOf("''");
      if (q !== -1) v = v.slice(q + 2);
      try {
        return decodeURIComponent(v);
      } catch (e) {
        /* malformed percent-encoding — fall through to the plain form */
      }
    }
    const plain = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*("([^"]*)"|[^;]+)`, 'i').exec(header);
    return plain ? (plain[2] != null ? plain[2] : plain[1]).trim() : '';
  }

  function attachmentNameOf(part) {
    if (!part) return '';
    const ct = (part.contentType || '').toLowerCase();
    if (!ct || ct.startsWith('multipart/')) return '';
    if (NOT_ATTACHMENT_TYPES.has(ct)) return '';
    // Thunderbird's placeholder for an attachment that has been deleted.
    if (ct.startsWith('text/x-moz-deleted')) return '';

    const disposition = headerFirst(part, 'content-disposition');
    const explicit = /^\s*attachment\b/i.test(disposition);
    const name =
      (typeof part.name === 'string' ? part.name : '') ||
      paramOf(disposition, 'filename') ||
      paramOf(headerFirst(part, 'content-type'), 'name');

    if (ct === 'message/rfc822') return name || 'ForwardedMessage.eml';
    if (ct.startsWith('text/')) return explicit ? name || ct : '';
    // An image the body references (cid) and marks inline is embedded, not an
    // attachment — Thunderbird hides those from its attachment pane too.
    if (/^\s*inline\b/i.test(disposition) && headerFirst(part, 'content-id')) {
      return '';
    }
    // Non-text: a filename means an attachment; without one, only an explicit
    // attachment disposition counts (a nameless cid image is body furniture).
    if (!name && !explicit) return '';
    return name || ct;
  }

  function collectAttachments(full) {
    const names = [];
    const walk = (part) => {
      if (!part || names.length >= MAX_ATTACHMENT_NAMES) return;
      const name = attachmentNameOf(part);
      if (name) names.push(name);
      for (const child of part.parts || []) walk(child);
    };
    // Start at the wrapper's children, never at the wrapper itself: getFull
    // always returns a synthetic root part whose contentType is
    // "message/rfc822" (convertMessagePart's isRoot branch, rv.parts = [real
    // root]). Classifying that root made every message report a
    // "ForwardedMessage.eml" attachment.
    for (const child of (full && full.parts) || []) walk(child);
    return names;
  }

  // headerMeta carries the already-resolved header fields (built on the main
  // thread, since they come off the MessageHeader object): id, headerMessageId,
  // subject, from, to, date (ms), folderName, accountId, accountName.
  //
  // Every string that will be stored is normalised here (see clean): the
  // subject and sender are decoded by Thunderbird and can contain a lone
  // surrogate just as a cut body can, and one of those fails a whole ingest
  // batch.
  function makeDoc(headerMeta, text, available, encrypted, attachments) {
    const body = clean(text || '');
    return {
      id: headerMeta.id,
      headerMessageId: clean(headerMeta.headerMessageId || ''),
      encrypted: !!encrypted,
      subject: clean(headerMeta.subject || ''),
      from: clean(headerMeta.from || ''),
      to: clean(headerMeta.to || ''),
      body,
      preview: previewOf(body),
      date: headerMeta.date || 0,
      folderName: clean(headerMeta.folderName || ''),
      accountId: headerMeta.accountId || '',
      accountName: clean(headerMeta.accountName || ''),
      bodyAvailable: available,
      attachments: (attachments || []).map(clean),
    };
  }

  // Build a doc from a NON-decrypted MIME tree. Returns { doc } normally, or
  // { needsDecrypt: true } when the message is encrypted and the caller opted to
  // index encrypted bodies — the decrypt read must happen on the main thread.
  function buildDoc(headerMeta, full, indexEncrypted, maxBody) {
    if (isEncrypted(full)) {
      // A non-decrypted encrypted tree has no readable parts, so there are no
      // attachment names to collect (decrypted trees go through
      // buildDecryptedDoc below).
      if (!indexEncrypted) return { doc: makeDoc(headerMeta, '', false, true, []) };
      return { needsDecrypt: true };
    }
    const text = cap(extractText(full), maxBody);
    return {
      doc: makeDoc(headerMeta, text, text.length > 0, false, collectAttachments(full)),
    };
  }

  // Build a doc from an already-decrypted MIME tree (encrypted message, opted in).
  function buildDecryptedDoc(headerMeta, full, maxBody) {
    const text = cap(extractText(full), maxBody);
    return {
      doc: makeDoc(headerMeta, text, text.length > 0, true, collectAttachments(full)),
    };
  }

  globalThis.OmniExtract = {
    PREVIEW_LEN,
    DEFAULT_MAX_BODY,
    MAX_ATTACHMENT_NAMES,
    isEncrypted,
    extractText,
    collectAttachments,
    makeDoc,
    buildDoc,
    buildDecryptedDoc,
  };
})();
