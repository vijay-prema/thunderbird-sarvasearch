'use strict';
// "Did a machine send this?" — one rule, decided once, at index time.
// Exposes globalThis.SarvaNotify.
//
// The judgement is stored as the payload boolean `notification`, not evaluated
// at query time, because Qdrant's text index tokenizes: `no-reply@example.com`
// arrives as two tokens, and `min_token_len: 2` drops "no", so a query-side
// match for "no-reply" would land on "reply" — matching every human called
// Reply and little else precisely. A stored flag has no such ambiguity: the
// filter is a bool match, and `must_not` on it still includes points indexed
// before the flag existed (they read as "not a notification").
//
// Only the address is judged, not the display name: "Notifications
// <casey@example.com>" is a real person's mailbox.
(function () {
  // Local parts (the bit before "@") that mean "nobody is reading this".
  // Anchored where a prefix is unambiguous; matched anywhere only for the
  // no-reply family and "notification", which carry their meaning in a word
  // nobody is named. Deliberately absent: info@, support@, sales@, news@ —
  // monitored human mailboxes and marketing, not notifications.
  //
  // Changing this list changes what the stored flag means, so a rule change
  // needs a new migration name in lib/index.js (MIGRATIONS), or indexes built
  // before the change keep their old judgement.
  const LOCAL_PATTERNS = [
    /(?:^|[-_.])(?:no|do[-_.]?not)[-_.]?reply/, // noreply@ no-reply@ team-no.reply@
    /notifications?(?:[-_.+]|$)/, // notifications@ tollingnotifications@
    /^notif(?:y|ier)(?:[-_.+]|$)/, // notify@ notifier@
    /^mailer(?:[-_.+]|$)/, // mailer@ mailer-daemon@
    /^postmaster(?:[-_.+]|$)/, // delivery reports
    /^bounces?(?:\+|-|_|\.|$)/, // bounces@ bounces+123@
    /^auto[-_.]?(?:reply|response|responder|confirm|confirmation|mailer)/, // auto-reply@ auto_confirm@
    /^automated(?:[-_.+]|$)/, // automated@
    /^(?:alerts?|newsletters?|digest|updates?)(?:\+|-|_|\.|$)/, // alerts@ newsletter@ digest@
  ];

  // A sender field may be "Name <addr>", a bare address, or a whole group
  // syntax list; every address in it is a candidate.
  function addressesOf(value) {
    const out = [];
    const re = /[^\s<>()",;:]+@[^\s<>()",;:]+/g;
    const text = String(value == null ? '' : value);
    let match;
    while ((match = re.exec(text))) out.push(match[0]);
    return out;
  }

  function isNotificationLocalPart(localPart) {
    const local = String(localPart || '').toLowerCase();
    return LOCAL_PATTERNS.some((pattern) => pattern.test(local));
  }

  function isNotification(from) {
    const addresses = addressesOf(from);
    if (!addresses.length) {
      // No parsable address (a display name only): the weakest form of the
      // same test, on the whole field, so "No Reply" still counts.
      return /no[\s._-]?reply|notif/i.test(String(from || ''));
    }
    return addresses.some((address) => isNotificationLocalPart(address.slice(0, address.lastIndexOf('@'))));
  }

  globalThis.SarvaNotify = {
    LOCAL_PATTERNS,
    addressesOf,
    isNotificationLocalPart,
    isNotification,
  };
})();
