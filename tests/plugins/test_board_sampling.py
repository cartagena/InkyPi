"""Unit tests for plugins.board.sampling — SPEC §7.5."""

from __future__ import annotations

from datetime import date

from plugins.board import sampling


class TestSeededRng:
    def test_same_day_and_key_is_deterministic(self) -> None:
        today = date(2026, 9, 3)
        rng_a = sampling.seeded_rng(today, "Projects")
        rng_b = sampling.seeded_rng(today, "Projects")
        assert [rng_a.random() for _ in range(5)] == [rng_b.random() for _ in range(5)]

    def test_different_day_yields_different_sequence(self) -> None:
        rng_a = sampling.seeded_rng(date(2026, 9, 3), "Projects")
        rng_b = sampling.seeded_rng(date(2026, 9, 4), "Projects")
        assert [rng_a.random() for _ in range(5)] != [rng_b.random() for _ in range(5)]

    def test_different_seed_key_yields_different_sequence(self) -> None:
        today = date(2026, 9, 3)
        rng_a = sampling.seeded_rng(today, "Projects")
        rng_b = sampling.seeded_rng(today, "Other Board Instance")
        assert [rng_a.random() for _ in range(5)] != [rng_b.random() for _ in range(5)]


class TestWeightedSampleWithoutReplacement:
    def test_returns_k_distinct_items(self) -> None:
        rng = sampling.seeded_rng(date(2026, 9, 3), "seed")
        items = list(range(10))
        out = sampling.weighted_sample_without_replacement(
            rng, items, lambda i: 1.0, k=4
        )
        assert len(out) == 4
        assert len(set(out)) == 4
        assert set(out) <= set(items)

    def test_k_zero_returns_empty(self) -> None:
        rng = sampling.seeded_rng(date(2026, 9, 3), "seed")
        assert (
            sampling.weighted_sample_without_replacement(
                rng, [1, 2, 3], lambda i: 1.0, k=0
            )
            == []
        )

    def test_empty_items_returns_empty(self) -> None:
        rng = sampling.seeded_rng(date(2026, 9, 3), "seed")
        assert (
            sampling.weighted_sample_without_replacement(rng, [], lambda i: 1.0, k=3)
            == []
        )

    def test_k_larger_than_items_returns_all_as_a_ranking(self) -> None:
        rng = sampling.seeded_rng(date(2026, 9, 3), "seed")
        items = [1, 2, 3]
        out = sampling.weighted_sample_without_replacement(
            rng, items, lambda i: 1.0, k=10
        )
        assert set(out) == set(items)

    def test_same_seed_is_stable_within_a_day(self) -> None:
        today = date(2026, 9, 3)
        items = list(range(20))
        out_a = sampling.weighted_sample_without_replacement(
            sampling.seeded_rng(today, "Projects"), items, lambda i: 1.0, k=4
        )
        out_b = sampling.weighted_sample_without_replacement(
            sampling.seeded_rng(today, "Projects"), items, lambda i: 1.0, k=4
        )
        assert out_a == out_b

    def test_heavier_weight_surfaces_more_often_across_days(self) -> None:
        """Not pinned to always appear, but a much heavier weight should be
        selected more often than a much lighter one across many independent
        daily draws."""
        items = ["heavy", "light"]
        weights = {"heavy": 100.0, "light": 1.0}
        heavy_count = 0
        trials = 200
        for day_offset in range(trials):
            today = date(2026, 1, 1).fromordinal(
                date(2026, 1, 1).toordinal() + day_offset
            )
            rng = sampling.seeded_rng(today, "seed")
            picked = sampling.weighted_sample_without_replacement(
                rng, items, lambda i: weights[i], k=1
            )
            if picked == ["heavy"]:
                heavy_count += 1
        assert heavy_count > trials * 0.8

    def test_light_item_can_still_be_drawn_never_fully_pinned_out(self) -> None:
        items = ["heavy", "light"]
        weights = {"heavy": 100.0, "light": 1.0}
        light_ever_picked = False
        for day_offset in range(500):
            today = date(2026, 1, 1).fromordinal(
                date(2026, 1, 1).toordinal() + day_offset
            )
            rng = sampling.seeded_rng(today, "seed")
            picked = sampling.weighted_sample_without_replacement(
                rng, items, lambda i: weights[i], k=1
            )
            if picked == ["light"]:
                light_ever_picked = True
                break
        assert light_ever_picked
