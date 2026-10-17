"""Health and platform routes."""
from __future__ import annotations

from fastapi import APIRouter

from .. import platform
from ..models import Health, PlatformStatus

router = APIRouter()
VERSION = "1.0.0"


@router.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", version=VERSION, data_source=platform.data_source())


@router.get("/platform/status", response_model=PlatformStatus)
def platform_status() -> PlatformStatus:
    return PlatformStatus(**platform.status())
