"""固定シフトの先生（①シフト表に出てこない/毎月同じ勤務の先生）の設定。

例:
  ・統括の先生 … 土日祝休みで 9:30〜18:30、休憩60分
  ・土曜だけ出勤の先生 … 土曜 13:00〜18:00

`fixed_shifts.json`（無ければ設定なし）に書いておくと、①から読めた勤務に加えて
自動で埋める。①に記載がある日は①が優先（実際の予定が入っているため）。
"""

from __future__ import annotations

import calendar
import datetime
import json
import os
from dataclasses import dataclass, field

from . import jp_holidays
from . import textutil as tu
from .shift import DayEntry

WEEKDAY_CHARS = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6}
WEEKDAY_NAMES = {v: k for k, v in WEEKDAY_CHARS.items()}
WEEKDAY_GROUPS = {
    "平日": {0, 1, 2, 3, 4},
    "土日": {5, 6},
    "毎日": {0, 1, 2, 3, 4, 5, 6},
    "全日": {0, 1, 2, 3, 4, 5, 6},
}

DEFAULT_FILENAME = "fixed_shifts.json"


class FixedShiftConfigError(ValueError):
    """設定ファイルの書き方が誤っている。"""


def parse_weekdays(value) -> set[int]:
    """"平日" / "土" / "月-金" / ["月","水"] を曜日番号(月=0)の集合にする。"""
    if isinstance(value, (list, tuple)):
        result: set[int] = set()
        for item in value:
            result |= parse_weekdays(item)
        return result

    text = tu.normalize(value).replace(" ", "")
    for token in ("、", ",", "・"):
        if token in text:
            return parse_weekdays(text.split(token))
    if text in WEEKDAY_GROUPS:
        return set(WEEKDAY_GROUPS[text])

    text = text.replace("曜日", "").replace("曜", "")
    for sep in ("〜", "～", "-", "~"):
        if sep in text:
            start_c, _, end_c = text.partition(sep)
            if start_c in WEEKDAY_CHARS and end_c in WEEKDAY_CHARS:
                start, end = WEEKDAY_CHARS[start_c], WEEKDAY_CHARS[end_c]
                span = range(start, end + 1) if start <= end else list(range(start, 7)) + list(range(0, end + 1))
                return set(span)
    days = {WEEKDAY_CHARS[c] for c in text if c in WEEKDAY_CHARS}
    if not days:
        raise FixedShiftConfigError(f"曜日の指定を解釈できません: {value!r}（例: \"平日\", \"土\", \"月-金\"）")
    return days


@dataclass
class FixedRule:
    """1人分の固定シフト。"""

    person: str
    weekdays: set[int]
    start: datetime.time
    end: datetime.time
    break_minutes: int | None = None      # None なら通常ルール（6時間超で60分）
    file_hint: str | None = None          # 書き込み先の③ファイル名（部分一致）
    exclude_holidays: bool = True         # 祝日を除くか
    note: str = ""

    @property
    def weekday_label(self) -> str:
        return "".join(WEEKDAY_NAMES[w] for w in sorted(self.weekdays))

    @property
    def label(self) -> str:
        holiday = "祝日除く" if self.exclude_holidays else "祝日も出勤"
        return (f"固定シフト（{self.weekday_label} {self.start:%H:%M}〜{self.end:%H:%M}"
                f"／{holiday}）{('／' + self.note) if self.note else ''}")


@dataclass
class FixedShiftConfig:
    rules: list[FixedRule] = field(default_factory=list)
    extra_holidays: set[datetime.date] = field(default_factory=set)

    def __bool__(self) -> bool:
        return bool(self.rules)


def _parse_time_pair(rule: dict) -> tuple[datetime.time, datetime.time]:
    if "time" in rule:
        ranges = tu.parse_time_ranges(rule["time"])
        if not ranges:
            raise FixedShiftConfigError(f"勤務時間を解釈できません: {rule['time']!r}（例: \"9:30-18:30\"）")
        return ranges[0]
    if "start" in rule and "end" in rule:
        start = tu.parse_clock(tu.normalize(rule["start"]))
        end = tu.parse_clock(tu.normalize(rule["end"]))
        if start is None or end is None:
            raise FixedShiftConfigError(f"勤務時間を解釈できません: {rule.get('start')} 〜 {rule.get('end')}")
        return start, end
    raise FixedShiftConfigError(f"time（勤務時間）がありません: {rule}")


def _parse_date(value) -> datetime.date:
    if isinstance(value, datetime.date):
        return value
    text = tu.normalize(value).replace("/", "-")
    try:
        return datetime.date.fromisoformat(text)
    except ValueError as exc:
        raise FixedShiftConfigError(f"日付を解釈できません: {value!r}（例: \"2026-08-13\"）") from exc


def load_config(path: str) -> FixedShiftConfig:
    """fixed_shifts.json を読む。ファイルが無ければ空の設定を返す。"""
    if not path or not os.path.isfile(path):
        return FixedShiftConfig()
    with open(path, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as exc:
            raise FixedShiftConfigError(f"{os.path.basename(path)} の書式が壊れています: {exc}") from exc

    default_exclude = bool(data.get("exclude_holidays_default", True))
    config = FixedShiftConfig(
        extra_holidays={_parse_date(v) for v in data.get("extra_holidays", [])},
    )
    for raw in data.get("rules", []):
        person = tu.normalize_person(raw.get("person", ""))
        if not person:
            raise FixedShiftConfigError(f"person（氏名）がありません: {raw}")
        start, end = _parse_time_pair(raw)
        config.rules.append(FixedRule(
            person=person,
            weekdays=parse_weekdays(raw.get("weekdays", "平日")),
            start=start,
            end=end,
            break_minutes=raw.get("break_minutes"),
            file_hint=raw.get("file"),
            exclude_holidays=bool(raw.get("exclude_holidays", default_exclude)),
            note=raw.get("note", ""),
        ))
    return config


def expand(config: FixedShiftConfig, year: int, month: int) -> list[DayEntry]:
    """固定シフトを、その月の日ごとの DayEntry に展開する。"""
    entries: list[DayEntry] = []
    if not config:
        return entries

    days_in_month = calendar.monthrange(year, month)[1]
    for rule in config.rules:
        for day in range(1, days_in_month + 1):
            date = datetime.date(year, month, day)
            if date.weekday() not in rule.weekdays:
                continue
            if rule.exclude_holidays and (jp_holidays.is_holiday(date) or date in config.extra_holidays):
                continue
            entries.append(DayEntry(
                day=day,
                person=rule.person,
                kind="time",
                shifts=[(rule.start, rule.end)],
                break_minutes=rule.break_minutes,
                file_hint=rule.file_hint,
                sources=["固定シフト設定"],
                raws=[f"{rule.start:%H:%M}-{rule.end:%H:%M}"],
                notes=[rule.label],
            ))
    return entries


def merge_into(merged: dict[tuple[str, int], DayEntry], entries: list[DayEntry]) -> int:
    """①から読めた勤務に固定シフトを足す。①に記載がある日は①を優先する。

    戻り値は追加した件数。
    """
    added = 0
    for entry in entries:
        key = (entry.person, entry.day)
        if key in merged:
            merged[key].notes.append("固定シフト設定より①の記載を優先")
            continue
        merged[key] = entry
        added += 1
    return added
