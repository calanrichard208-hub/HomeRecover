"""Minimal API around the trend engine. Run: uvicorn app.main:app --reload"""
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from .trend import CheckIn, RedFlagLimits, assess

app = FastAPI(title="HomeRecover API")


class CheckInIn(BaseModel):
    day: int = Field(ge=1)
    pain: int = Field(ge=0, le=10)
    fever_f: Optional[float] = None
    wound_discharge: bool = False


class LimitsIn(BaseModel):
    fever_limit_f: float = 100.4
    pain_limit: int = 8


class TrendRequest(BaseModel):
    checkins: List[CheckInIn]
    limits: LimitsIn = LimitsIn()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/trend")
def trend(req: TrendRequest):
    result = assess(
        [CheckIn(**c.model_dump()) for c in req.checkins],
        RedFlagLimits(**req.limits.model_dump()),
    )
    return {"status": result.status, "reasons": result.reasons}
