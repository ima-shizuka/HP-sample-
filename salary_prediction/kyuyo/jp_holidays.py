"""日本の祝日（国民の祝日・振替休日・国民の休日）を計算する。

固定シフトの先生（例:「土日祝休みで9:30〜18:30」）の勤務日を出すために使う。
外部ライブラリもネット接続も使わず、法律どおりの規則から計算する。
1980〜2099年の範囲で有効（春分・秋分の近似式の有効範囲）。
"""

from __future__ import annotations

import datetime
from functools import lru_cache

MONDAY = 0
SUNDAY = 6


def _nth_monday(year: int, month: int, nth: int) -> datetime.date:
    """その月の第 nth 月曜日（ハッピーマンデー用）。"""
    day = datetime.date(year, month, 1)
    offset = (MONDAY - day.weekday()) % 7
    return day + datetime.timedelta(days=offset + 7 * (nth - 1))


def _vernal_equinox(year: int) -> int:
    """春分の日（近似式）。"""
    return int(20.8431 + 0.242194 * (year - 1980) - (year - 1980) // 4)


def _autumnal_equinox(year: int) -> int:
    """秋分の日（近似式）。"""
    return int(23.2488 + 0.242194 * (year - 1980) - (year - 1980) // 4)


@lru_cache(maxsize=32)
def holidays(year: int) -> dict[datetime.date, str]:
    """その年の祝日 {日付: 名称}。振替休日・国民の休日を含む。"""
    d = datetime.date
    base: dict[datetime.date, str] = {
        d(year, 1, 1): "元日",
        d(year, 2, 11): "建国記念の日",
        d(year, 3, _vernal_equinox(year)): "春分の日",
        d(year, 4, 29): "昭和の日",
        d(year, 5, 3): "憲法記念日",
        d(year, 5, 4): "みどりの日",
        d(year, 5, 5): "こどもの日",
        d(year, 8, 11): "山の日",
        d(year, 9, _autumnal_equinox(year)): "秋分の日",
        d(year, 11, 3): "文化の日",
        d(year, 11, 23): "勤労感謝の日",
        _nth_monday(year, 1, 2): "成人の日",
        _nth_monday(year, 9, 3): "敬老の日",
        _nth_monday(year, 10, 2): "スポーツの日",
        _nth_monday(year, 7, 3): "海の日",
    }
    base[d(year, 2, 23) if year >= 2020 else d(year, 12, 23)] = "天皇誕生日"

    # 東京オリンピック（2020・2021）に伴う特例移動
    if year == 2020:
        base.pop(_nth_monday(2020, 7, 3), None)
        base.pop(_nth_monday(2020, 10, 2), None)
        base.pop(d(2020, 8, 11), None)
        base.update({d(2020, 7, 23): "海の日", d(2020, 7, 24): "スポーツの日",
                     d(2020, 8, 10): "山の日"})
    elif year == 2021:
        base.pop(_nth_monday(2021, 7, 3), None)
        base.pop(_nth_monday(2021, 10, 2), None)
        base.pop(d(2021, 8, 11), None)
        base.update({d(2021, 7, 22): "海の日", d(2021, 7, 23): "スポーツの日",
                     d(2021, 8, 8): "山の日"})

    result = dict(base)

    # 振替休日: 祝日が日曜のとき、その後の最初の平日
    for date in sorted(base):
        if date.weekday() != SUNDAY:
            continue
        nxt = date + datetime.timedelta(days=1)
        while nxt in result:
            nxt += datetime.timedelta(days=1)
        result[nxt] = "振替休日"

    # 国民の休日: 祝日に挟まれた平日（例: 敬老の日と秋分の日の間）
    for date in sorted(base):
        middle = date + datetime.timedelta(days=1)
        after = date + datetime.timedelta(days=2)
        if after in base and middle not in result and middle.weekday() != SUNDAY:
            result[middle] = "国民の休日"

    return result


def is_holiday(date: datetime.date) -> bool:
    return date in holidays(date.year)


def holiday_name(date: datetime.date) -> str | None:
    return holidays(date.year).get(date)
