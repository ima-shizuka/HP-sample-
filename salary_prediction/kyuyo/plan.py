"""①から読み取った勤務を、③のどのセルにどう書くかまで落とし込む（＝書き込み計画）。

いきなり③を書き換えず、まずこの計画を人が目視確認できる形（レポート）に出す、
という運用を前提にしている（SPEC.md「まだ確認・検証が済んでいないこと」7.）。
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field

from . import textutil as tu
from .kintai_index import KintaiIndex, SheetRef
from .shift import DayEntry

# ③の個人シートのレイアウト（SPEC.md「③への書き込みルール」）
FIRST_DAY_ROW = 13        # 13行目 = 1日目
LAST_DAY_ROW = 43
COL_START = 3             # C列 出勤時間
COL_END = 5               # E列 退勤時間
COL_BREAK = 11            # K列 休憩(分)
COL_NOTE = 20             # T列 特記（有休・欠勤等）

# 休憩の既定ルール: 勤務時間が6時間を超える日は60分（給与予測目的の仮ルール、要検証）
BREAK_THRESHOLD_MIN = 6 * 60
BREAK_MIN = 60


@dataclass
class WritePlan:
    """③の1行（＝ある先生の1日）に対する書き込み内容。"""

    person: str
    day: int
    ref: SheetRef | None
    row: int | None
    status: str                       # "write" | "skip" | "review"
    reason: str = ""
    start: datetime.time | None = None
    end: datetime.time | None = None
    break_minutes: int | None = None
    note: str | None = None           # T列
    kind: str = ""
    sources: list[str] = field(default_factory=list)
    raws: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        if self.note:
            return self.note
        if self.start and self.end:
            brk = f" 休憩{self.break_minutes}分" if self.break_minutes else ""
            return f"{self.start:%H:%M}〜{self.end:%H:%M}{brk}"
        return "-"


def compute_break_minutes(shifts: list[tuple[datetime.time, datetime.time]]) -> int:
    """K列に入れる休憩(分)を求める。

    - 勤務時間（＝出勤〜退勤の各レンジの合計）が6時間を超える日は60分（仮ルール）
    - 分割シフト（1日2回勤務）は C列=最初の出勤・E列=最後の退勤 で記録するため、
      間の空き時間も休憩として計上する（そうしないと空き時間が勤務時間になってしまう）
    """
    if not shifts:
        return 0
    worked = sum(tu.minutes_between(s, e) for s, e in shifts)
    span = tu.minutes_between(min(s for s, _ in shifts), max(e for _, e in shifts))
    gap = max(span - worked, 0)
    return gap + (BREAK_MIN if worked > BREAK_THRESHOLD_MIN else 0)


def build_plans(
    merged: dict[tuple[str, int], DayEntry],
    index: KintaiIndex,
    from_day: int = 1,
    to_day: int = 31,
) -> list[WritePlan]:
    """(氏名,日)ごとの DayEntry を WritePlan に変換する。

    from_day / to_day で対象日を絞る（事務が入力済みの中締めより後だけを埋める運用）。
    """
    plans: list[WritePlan] = []
    for (person, day), entry in sorted(merged.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        ref, reason = index.resolve(person, entry.file_hint)
        row = FIRST_DAY_ROW + day - 1 if ref else None

        plan = WritePlan(
            person=person,
            day=day,
            ref=ref,
            row=row,
            status="review",
            reason=reason,
            kind=entry.kind,
            sources=list(entry.sources),
            raws=list(entry.raws),
            notes=list(entry.notes),
            warnings=list(entry.warnings),
        )

        if not (from_day <= day <= to_day):
            plan.status = "skip"
            plan.reason = f"対象期間({from_day}〜{to_day}日)外"
            plans.append(plan)
            continue

        if entry.kind == "holiday":
            plan.status = "skip"
            plan.reason = "休み（③には何も書かない）"
            plans.append(plan)
            continue

        if ref is None:
            plan.warnings.append(f"③の書き込み先が決まらない: {reason}")
            plans.append(plan)
            continue

        if row is None or not (FIRST_DAY_ROW <= row <= LAST_DAY_ROW):
            plan.status = "review"
            plan.warnings.append(f"{day}日は③の行範囲({FIRST_DAY_ROW}〜{LAST_DAY_ROW})外")
            plans.append(plan)
            continue

        if entry.kind == "time" and entry.shifts:
            plan.start = min(s for s, _ in entry.shifts)
            plan.end = max(e for _, e in entry.shifts)
            plan.break_minutes = (entry.break_minutes if entry.break_minutes is not None
                                  else compute_break_minutes(entry.shifts))
            plan.status = "review" if entry.warnings else "write"
            plan.reason = "勤務時間を転記" if plan.status == "write" else "要確認（警告あり）"
        elif entry.kind == "absence" and entry.absence:
            plan.note = entry.absence
            plan.status = "review" if entry.warnings else "write"
            plan.reason = f"T列に「{entry.absence}」" if plan.status == "write" else "要確認（警告あり）"
        else:
            plan.status = "review"
            plan.reason = "セルの内容を解釈できない" if entry.kind == "unknown" else "応援先の時刻が特定できない"

        plans.append(plan)
    return plans
