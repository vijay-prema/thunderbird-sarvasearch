'use strict';
// Message identity. Exposes globalThis.SarvaKey.
//
// Two identities, two jobs:
//
// - identity(header) — what the index keys records by:
//   (account_id, message_id), where message_id is the RFC Message-ID or, if
//   the mail lacks one (rare; Thunderbird usually synthesizes an md5: id),
//   a 'local:<numeric id>' fallback. The Qdrant point ID is derived from
//   exactly this pair (lib/text.js pointId), so the same value must always
//   come out here.
//
// - docKey(doc) — the local dedup key used while collecting the live set for
//   reconcile: account + message id, joined with a NUL separator that cannot
//   occur in either part.
//
// Never key off Thunderbird's numeric message id: it is "an internal tracking
// number that does not remain after a restart" — Thunderbird reissues those
// numbers each session from a low dense range, so a stored id starts
// addressing a DIFFERENT message. The RFC Message-ID is the stable identity
// (measured on a real profile by thunderbird-omnisearch: 99.7% of the numeric
// id range is occupied; see its docs/adr/0001).
(function () {
  // NUL separator, written as the ESCAPE '\0' so git keeps this file text.
  const SEP = '\0';

  // The (account_id, message_id) pair the index stores, as one flat object.
  function identity(header) {
    if (!header) return { account_id: '', message_id: '' };
    const accountId =
      (header.folder && header.folder.accountId) || header.accountId || '';
    const mid = header.headerMessageId || '';
    // No Message-ID: fall back to the numeric id, which is unstable across
    // restarts by definition. Deliberate: such a doc never collapses with
    // another (the safe failure), and reconcile cleans up the stale copy.
    const message_id = mid || 'local:' + String(header.id == null ? '' : header.id);
    return { account_id: accountId, message_id };
  }

  // Local dedup key for the reconcile live-set: account + message id.
  function docKey(doc) {
    if (!doc) return '';
    const mid = doc.headerMessageId || '';
    if (!mid) return 'local:' + (doc.id == null ? '' : String(doc.id));
    return (doc.accountId || '') + SEP + mid;
  }

  globalThis.SarvaKey = { docKey, identity, SEP };
})();
