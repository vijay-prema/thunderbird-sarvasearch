"""SearchService tests: keyword, semantic, hybrid fusion, filters, fallback."""

import pytest

from server.ingest import IngestDoc
from server.search import (
    SearchRequest,
    SemanticUnavailable,
    fts_match_string,
    parse_bound,
    rrf_fuse,
)


def search(services, **kw):
    return services.run(services.search.search(SearchRequest(**kw)))


def seed(services):
    services.run(services.ingest.ingest(IngestDoc(**d) for d in [
        services.make_doc(mid="plumb@x.com", subject="Invoice for plumbing work",
                          body="Please pay the invoice for the plumbing work."),
        services.make_doc(mid="party@x.com", subject="Party invitation",
                          body="You are invited to my birthday party on Saturday."),
        services.make_doc(mid="host@x.com", subject="Dinner party host duties",
                          body="Bring plates to the dinner party."),
    ]))


def test_fts_match_string():
    assert fts_match_string("invo") == '"invo"*'
    assert fts_match_string("big invoice") == '"big"* OR "invoice"*'


def test_parse_bound_whole_day():
    start = parse_bound("2024-06-15", end=False)
    end = parse_bound("2024-06-15", end=True)
    assert end - start == 24 * 60 * 60 * 1000


def test_parse_bound_rejects_garbage():
    with pytest.raises(ValueError):
        parse_bound("not-a-date", end=False)


def test_rrf_fuse_ranks_both_engines_first():
    a = [("k1", 0.9), ("k2", 0.8), ("k3", 0.7)]
    b = [("k2", 5.0), ("k1", 4.0)]
    ordered, ranks = rrf_fuse({"a": a, "b": b}, k=60)
    keys = [k for k, _ in ordered]
    # k1 and k2 appear in both lists; k3 only in one — both beat k3.
    assert set(keys[:2]) == {"k1", "k2"}
    assert keys[2] == "k3"
    assert ranks["k1"]["a"] == (1, 0.9)
    assert ranks["k1"]["b"] == (2, 4.0)


def test_rrf_fuse_score_formula():
    a = [("k1", 1.0)]
    b = [("k1", 1.0)]
    ordered, _ = rrf_fuse({"a": a, "b": b}, k=60)
    assert ordered[0][1] == pytest.approx(2 * (1 / 61))


def test_keyword_mode_never_calls_embedder(services):
    seed(services)
    services.embedder.calls = 0
    r = search(services, query="invoice", mode="keyword")
    assert services.embedder.calls == 0
    assert [x["message_id"] for x in r["results"]] == ["plumb@x.com"]
    assert r["results"][0]["engines"]["keyword"]["rank"] == 1
    assert r["results"][0]["engines"]["semantic"] is None


def test_keyword_prefix_matches_partial_word(services):
    seed(services)
    r = search(services, query="invo", mode="keyword")
    assert [x["message_id"] for x in r["results"]] == ["plumb@x.com"]


def test_semantic_mode(services):
    seed(services)
    r = search(services, query="plumbing invoice work", mode="semantic")
    assert r["results"], "expected at least one semantic hit"
    assert r["results"][0]["message_id"] == "plumb@x.com"
    assert 0 < r["results"][0]["score"] <= 1.0


def test_hybrid_mode_ranks_shared_doc_first(services):
    seed(services)
    r = search(services, query="party invitation", mode="hybrid")
    ids = [x["message_id"] for x in r["results"]]
    # "party invitation" matches party@x.com in subject by keyword AND close
    # semantically (shares words); host@x.com only weakly.
    assert ids.index("party@x.com") < ids.index("host@x.com")
    top = r["results"][0]
    assert top["engines"]["semantic"] is not None
    assert top["engines"]["keyword"] is not None
    assert r["engines"]["semantic"]["available"] is True


def test_hybrid_falls_back_to_keyword_when_embedder_down(services):
    seed(services)
    services.embedder.fail_all = True
    r = search(services, query="invoice", mode="hybrid")
    assert r["mode_used"] == "keyword (semantic unavailable)"
    assert r["results"]
    assert r["results"][0]["engines"]["semantic"] is None
    services.embedder.fail_all = False


def test_semantic_mode_raises_when_embedder_down(services):
    seed(services)
    services.embedder.fail_all = True
    with pytest.raises(SemanticUnavailable):
        search(services, query="invoice", mode="semantic")
    services.embedder.fail_all = False


def test_account_filter(services):
    seed(services)
    services.run(services.ingest.ingest([
        IngestDoc(**services.make_doc(
            mid="other@x.com", account_id="account2", subject="Invoice from elsewhere"
        ))
    ]))
    r = search(services, query="invoice", mode="hybrid", account="account1")
    assert {x["account"] for x in r["results"]} == {"account1"}


def test_from_and_date_filters(services):
    seed(services)
    # A third party doc from a different sender, so the from: filter has
    # something to exclude.
    services.run(services.ingest.ingest([IngestDoc(**services.make_doc(
        mid="crash@x.com", subject="Party cancelled", from_="carol@example.com",
        body="The party is cancelled.",
    ))]))

    r = search(services, query="party", mode="keyword")
    assert len(r["results"]) == 3

    r = search(services, query="party", mode="keyword", **{"from": "carol@example.com"})
    assert [x["message_id"] for x in r["results"]] == ["crash@x.com"]

    r = search(services, query="party", mode="keyword",
               after="2000-01-01", before="2100-01-01")
    assert len(r["results"]) == 3

    r = search(services, query="party", mode="keyword", before="2000-01-01")
    assert r["results"] == []


def test_invalid_mode_rejected(services):
    with pytest.raises(ValueError):
        search(services, query="x", mode="bogus")


def test_empty_query(services):
    r = search(services, query="   ", mode="hybrid")
    assert r["results"] == []
